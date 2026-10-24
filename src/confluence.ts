import { openAsBlob } from "node:fs";
import type { Owner, Remote, RemotePage } from "./plan";
import type { Attachment } from "./source";

/** The content property that marks a page as published by this action. */
export const OWNER_KEY = "confluence-publish-action";
/** The property that confluence-markdown-sync-action wrote. */
const LEGACY_KEY = "filePath";
const HASH_COMMENT = "sha256:";

const timeoutMs = 30_000;
const maxAttempts = 4;
const baseDelayMs = 500;
const maxDelayMs = 10_000;
const maxRetryAfterMs = 60_000;
const pageSize = 250;
const maxDepth = 10;
const readConcurrency = 5;

export class ConfluenceError extends Error {
	/** The HTTP status, or null when no response arrived and the outcome is unknown. */
	readonly status: number | null;
	/** The request path relative to the base URL. */
	readonly path: string;

	constructor(message: string, status: number | null, path: string) {
		super(message);
		this.name = "ConfluenceError";
		this.status = status;
		this.path = path;
	}
}

export interface OwnerValue {
	source: string;
	digest: string;
	version: number;
}

export interface ConfluenceOptions {
	/** Site or gateway URL ending in /wiki. */
	baseUrl: string;
	email: string;
	token: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Returns a number in [0, 1) for backoff jitter. */
	random?: () => number;
}

interface PageJson {
	id: string;
	title: string;
	spaceId: string;
	parentId: string;
	authorId: string;
	version: { number: number };
	_links: { base?: string; webui?: string };
}

interface ListJson<T> {
	results: T[];
	_links?: { next?: string };
}

interface DescendantJson {
	id: string;
	title: string;
	type: string;
	parentId: string;
	depth: number;
}

interface PropertyJson {
	id: string;
	key: string;
	value: unknown;
	version: { number: number };
}

interface AttachmentJson {
	id: string;
	title: string;
	comment?: string;
}

/**
 * Confluence Cloud REST client. Pages and properties use REST v2. Attachment upload and the current
 * user use REST v1, which has no v2 equivalent.
 *
 * Retries: GET and DELETE retry on network errors and 5xx. Every method retries on 429, which
 * Confluence returns before it processes a request. A POST or PUT without a response is not
 * retried, because its outcome is unknown.
 */
export class Confluence {
	readonly #base: string;
	readonly #authorization: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #random: () => number;

	constructor(options: ConfluenceOptions) {
		this.#base = options.baseUrl;
		this.#authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;
		this.#fetch = options.fetch ?? fetch;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#random = options.random ?? Math.random;
	}

	async readRemote(rootId: string): Promise<Remote & { spaceId: string; webBase: string }> {
		const root = await this.#json<PageJson>("GET", `/api/v2/pages/${rootId}`);
		const user = await this.#json<{ accountId: string }>("GET", "/rest/api/user/current");
		const tree = await this.#descendants(rootId);

		const details = new Map<string, PageJson>();
		for (let i = 0; i < tree.length; i += pageSize) {
			const ids = tree.slice(i, i + pageSize).map((page) => page.id);
			const list = await this.#json<ListJson<PageJson>>(
				"GET",
				`/api/v2/pages?id=${ids.join(",")}&limit=${pageSize}`,
			);
			for (const page of list.results) details.set(page.id, page);
		}
		const owners = await mapLimit(tree, readConcurrency, (page) => this.#owner(page.id));

		const pages: RemotePage[] = tree.flatMap((page, i) => {
			const detail = details.get(page.id);
			if (!detail) return [];
			return [
				{
					id: page.id,
					parentId: page.parentId,
					title: page.title,
					version: detail.version.number,
					authorId: detail.authorId,
					owner: owners[i] ?? null,
				},
			];
		});
		return {
			rootId,
			accountId: user.accountId,
			spaceId: root.spaceId,
			webBase: root._links.base ?? this.#base,
			pages,
		};
	}

	/** Maps each lower-case title to the ID of a page in the space that has it. */
	async titleHolders(spaceId: string, titles: string[]): Promise<Map<string, string>> {
		const found = await mapLimit(titles, readConcurrency, (title) => this.findPage(spaceId, title));
		const holders = new Map<string, string>();
		titles.forEach((title, i) => {
			const page = found[i];
			if (page) holders.set(title.toLowerCase(), page.id);
		});
		return holders;
	}

	async findPage(spaceId: string, title: string): Promise<PageJson | null> {
		const list = await this.#json<ListJson<PageJson>>(
			"GET",
			`/api/v2/pages?space-id=${spaceId}&title=${encodeURIComponent(title)}&limit=1`,
		);
		return list.results[0] ?? null;
	}

	/** Returns the new page ID, or null when no response arrived and the outcome is unknown. */
	async createPage(page: {
		spaceId: string;
		parentId: string;
		title: string;
		body: string;
	}): Promise<string | null> {
		try {
			const created = await this.#json<PageJson>("POST", "/api/v2/pages", {
				spaceId: page.spaceId,
				status: "current",
				title: page.title,
				parentId: page.parentId,
				body: { representation: "storage", value: page.body },
			});
			return created.id;
		} catch (error) {
			if (error instanceof ConfluenceError && error.status === null) return null;
			throw error;
		}
	}

	/** `version` is the current version; the update writes the next one. */
	async updatePage(page: {
		id: string;
		parentId: string;
		title: string;
		body: string;
		version: number;
	}): Promise<void> {
		await this.#request("PUT", `/api/v2/pages/${page.id}`, {
			id: page.id,
			status: "current",
			title: page.title,
			parentId: page.parentId,
			body: { representation: "storage", value: page.body },
			version: { number: page.version + 1, message: "Published by confluence-publish-action" },
		});
	}

	async pageVersion(id: string): Promise<number> {
		return (await this.#json<PageJson>("GET", `/api/v2/pages/${id}`)).version.number;
	}

	async writeOwner(pageId: string, value: OwnerValue, property: Owner["property"]): Promise<void> {
		const body = { key: OWNER_KEY, value: { v: 1, ...value } };
		if (property) {
			await this.#request("PUT", `/api/v2/pages/${pageId}/properties/${property.id}`, {
				...body,
				version: { number: property.version + 1 },
			});
		} else {
			await this.#request("POST", `/api/v2/pages/${pageId}/properties`, body);
		}
	}

	/** Moves the page to the trash. A page that is already gone counts as deleted. */
	async deletePage(id: string): Promise<void> {
		try {
			await this.#request("DELETE", `/api/v2/pages/${id}`);
		} catch (error) {
			if (!(error instanceof ConfluenceError && error.status === 404)) throw error;
		}
	}

	/**
	 * Makes the page's attachments match `wanted`. Each upload carries its hash in the comment, so
	 * an unchanged file is not uploaded again. Attachments without such a comment belong to people
	 * and are never deleted.
	 */
	async syncAttachments(
		pageId: string,
		wanted: Attachment[],
	): Promise<{ uploaded: number; deleted: number }> {
		const existing = await this.#all<AttachmentJson>(
			`/api/v2/pages/${pageId}/attachments?limit=${pageSize}`,
		);
		let uploaded = 0;
		for (const attachment of wanted) {
			const current = existing.find((a) => a.title === attachment.name);
			if (current?.comment === HASH_COMMENT + attachment.sha256) continue;
			const form = new FormData();
			form.append("file", await openAsBlob(attachment.path), attachment.name);
			form.append("comment", HASH_COMMENT + attachment.sha256);
			form.append("minorEdit", "true");
			await this.#request("PUT", `/rest/api/content/${pageId}/child/attachment`, form);
			uploaded++;
		}

		const names = new Set(wanted.map((a) => a.name));
		const stale = existing.filter(
			(a) => a.comment?.startsWith(HASH_COMMENT) && !names.has(a.title),
		);
		for (const attachment of stale) {
			await this.#request("DELETE", `/api/v2/attachments/${attachment.id}`);
		}
		return { uploaded, deleted: stale.length };
	}

	async #descendants(rootId: string): Promise<DescendantJson[]> {
		const pages: DescendantJson[] = [];
		const queue = [rootId];
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			const found = await this.#all<DescendantJson>(
				`/api/v2/pages/${id}/descendants?depth=${maxDepth}&limit=${pageSize}`,
			);
			for (const item of found) {
				if (item.type !== "page") continue;
				pages.push(item);
				if (item.depth === maxDepth) queue.push(item.id);
			}
		}
		return pages;
	}

	async #owner(pageId: string): Promise<Owner | null> {
		const properties = await this.#all<PropertyJson>(
			`/api/v2/pages/${pageId}/properties?limit=${pageSize}`,
		);
		const own = properties.find((p) => p.key === OWNER_KEY);
		if (own) {
			const value = own.value as Partial<Record<keyof OwnerValue | "v", unknown>> | null;
			if (
				value?.v !== 1 ||
				typeof value.source !== "string" ||
				typeof value.digest !== "string" ||
				typeof value.version !== "number"
			) {
				throw new Error(
					`Page ${pageId} has an invalid ${OWNER_KEY} property: ${JSON.stringify(own.value)}. Delete the property or the page in Confluence.`,
				);
			}
			return {
				source: value.source,
				digest: value.digest,
				version: value.version,
				property: { id: own.id, version: own.version.number },
			};
		}
		const legacy = properties.find((p) => p.key === LEGACY_KEY);
		if (typeof legacy?.value === "string") {
			return { source: legacy.value, digest: null, version: null, property: null };
		}
		return null;
	}

	/** Reads every result page of a list endpoint. */
	async #all<T>(path: string): Promise<T[]> {
		const results: T[] = [];
		for (let next: string | undefined = path; next !== undefined; ) {
			const list: ListJson<T> = await this.#json<ListJson<T>>("GET", next);
			results.push(...list.results);
			next = list._links?.next;
		}
		return results;
	}

	async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await (await this.#request(method, path, body)).json()) as T;
	}

	/** `path` is relative to the base URL; a "/wiki/…" next link from Confluence also works. */
	async #request(method: string, path: string, body?: unknown): Promise<Response> {
		const url = this.#base + (path.startsWith("/wiki/") ? path.slice("/wiki".length) : path);
		const headers: Record<string, string> = {
			Authorization: this.#authorization,
			Accept: "application/json",
		};
		let payload: string | FormData | undefined;
		if (body instanceof FormData) {
			payload = body;
			headers["X-Atlassian-Token"] = "nocheck";
		} else if (body !== undefined) {
			payload = JSON.stringify(body);
			headers["Content-Type"] = "application/json";
		}
		const repeatable = method === "GET" || method === "DELETE";

		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				if (repeatable && attempt < maxAttempts) {
					await this.#sleep(this.#backoff(attempt));
					continue;
				}
				const reason = error instanceof Error ? error.message : String(error);
				throw new ConfluenceError(`${method} ${path} got no response: ${reason}`, null, path);
			}
			if (response.ok) return response;

			const retry = response.status === 429 || (repeatable && response.status >= 500);
			if (retry && attempt < maxAttempts) {
				await response.body?.cancel();
				await this.#sleep(this.#retryDelay(response, attempt));
				continue;
			}
			throw new ConfluenceError(
				`${method} ${path} failed with ${response.status}: ${await errorDetail(response)}`,
				response.status,
				path,
			);
		}
	}

	#backoff(attempt: number): number {
		return Math.round(this.#random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
	}

	#retryDelay(response: Response, attempt: number): number {
		const seconds = Number(response.headers.get("Retry-After"));
		if (response.status === 429 && Number.isFinite(seconds) && seconds > 0) {
			return Math.min(seconds * 1000, maxRetryAfterMs);
		}
		return this.#backoff(attempt);
	}
}

async function errorDetail(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const body = JSON.parse(text) as { message?: string; errors?: Array<{ title?: string }> };
		const titles = body.errors?.map((e) => e.title).filter(Boolean) ?? [];
		if (titles.length > 0) return titles.join("; ");
		if (body.message) return body.message;
	} catch {
		// Not JSON; fall through to the raw text.
	}
	return text.slice(0, 300) || response.statusText;
}

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) results[i] = await map(items[i] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
