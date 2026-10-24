/**
 * An in-memory Confluence Cloud for tests. It implements only the REST endpoints that the action
 * calls, with the rules that matter for correctness: titles unique per space ignoring case, version
 * checks on updates, the trash on delete, Basic auth, and the upload header.
 */

export const SITE = "https://example.atlassian.net";
export const BASE_URL = `${SITE}/wiki`;
export const EMAIL = "bot@example.com";
export const TOKEN = "token";
export const ACCOUNT = "account-bot";
const SPACE = "9000";

export interface FakeProperty {
	id: string;
	key: string;
	value: unknown;
	version: number;
}

export interface FakeAttachment {
	id: string;
	title: string;
	comment: string;
	bytes: Uint8Array;
	status: "current" | "trashed";
}

export interface FakePage {
	id: string;
	parentId: string | null;
	title: string;
	body: string;
	version: number;
	/** The account that created the page. */
	authorId: string;
	/** The account that wrote the latest version; tests set it to simulate a person's edit. */
	editorId: string;
	/** Confluence also lists folders, whiteboards and others under a page. */
	type: "page" | "folder";
	status: "current" | "trashed";
	properties: FakeProperty[];
	attachments: FakeAttachment[];
}

type Failure = "network" | "lost" | { status: number; retryAfter?: number };

interface Rule {
	matches: (method: string, path: string) => boolean;
	failure: Failure;
}

export class FakeConfluence {
	readonly pages = new Map<string, FakePage>();
	/** Every request in order, as "METHOD /path?query" without the /wiki prefix. */
	readonly requests: string[] = [];
	/** Real Confluence may or may not add a page version for an attachment upload; tests choose. */
	uploadBumpsVersion = true;
	#nextId = 1000;
	#rules: Rule[] = [];

	readonly rootId: string;

	constructor() {
		this.rootId = this.addPage({ title: "Docs", parentId: null });
	}

	addPage(page: {
		title: string;
		parentId: string | null;
		authorId?: string;
		type?: FakePage["type"];
		properties?: Record<string, unknown>;
	}): string {
		const id = this.#id();
		this.pages.set(id, {
			id,
			parentId: page.parentId,
			title: page.title,
			body: "",
			version: 1,
			authorId: page.authorId ?? ACCOUNT,
			editorId: page.authorId ?? ACCOUNT,
			type: page.type ?? "page",
			status: "current",
			properties: Object.entries(page.properties ?? {}).map(([key, value]) => ({
				id: this.#id(),
				key,
				value,
				version: 1,
			})),
			attachments: [],
		});
		return id;
	}

	/** Makes the next request that `matches` fail once, in the way `failure` says. */
	failNext(matches: (method: string, path: string) => boolean, failure: Failure): void {
		this.#rules.push({ matches, failure });
	}

	current(): FakePage[] {
		return [...this.pages.values()].filter((page) => page.status === "current");
	}

	childrenOf(id: string): FakePage[] {
		return this.current().filter((page) => page.parentId === id);
	}

	writes(): string[] {
		return this.requests.filter((request) => !request.startsWith("GET "));
	}

	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/wiki/, "");
		const method = request.method;
		this.requests.push(`${method} ${path}${url.search}`);

		const rule = this.#rules.find((candidate) => candidate.matches(method, path));
		if (rule) this.#rules.splice(this.#rules.indexOf(rule), 1);
		if (rule?.failure === "network") throw new TypeError("fetch failed");
		if (rule && typeof rule.failure === "object") {
			const headers: Record<string, string> = rule.failure.retryAfter
				? { "Retry-After": String(rule.failure.retryAfter) }
				: {};
			return json(rule.failure.status, { message: "injected failure" }, headers);
		}

		if (request.headers.get("Authorization") !== `Basic ${btoa(`${EMAIL}:${TOKEN}`)}`) {
			return json(401, { message: "Unauthorized" });
		}
		const response = await this.#route(method, path, url.searchParams, request);
		if (rule?.failure === "lost") throw new TypeError("fetch failed after the server applied it");
		return response;
	};

	async #route(
		method: string,
		path: string,
		query: URLSearchParams,
		request: Request,
	): Promise<Response> {
		const pageRoute = (handle: (page: FakePage, m: string[]) => Response | Promise<Response>) => {
			return (m: string[]) => {
				const page = this.#currentPage(m[1] as string);
				return page ? handle(page, m) : json(404, { message: "Page not found" });
			};
		};
		const routes: Array<[string, RegExp, (m: string[]) => Response | Promise<Response>]> = [
			["GET", /^\/rest\/api\/user\/current$/, () => json(200, { accountId: ACCOUNT })],
			["GET", /^\/api\/v2\/pages$/, () => this.#listPages(query)],
			["POST", /^\/api\/v2\/pages$/, async () => this.#createPage(await request.json())],
			["GET", /^\/api\/v2\/pages\/(\d+)$/, pageRoute((page) => json(200, this.#pageJson(page)))],
			[
				"PUT",
				/^\/api\/v2\/pages\/(\d+)$/,
				pageRoute(async (page) => this.#updatePage(page, await request.json())),
			],
			[
				"DELETE",
				/^\/api\/v2\/pages\/(\d+)$/,
				pageRoute((page) => {
					page.status = "trashed";
					for (const child of this.childrenOf(page.id)) child.parentId = page.parentId;
					return new Response(null, { status: 204 });
				}),
			],
			[
				"GET",
				/^\/api\/v2\/pages\/(\d+)\/descendants$/,
				(m) => this.#descendants(m[1] as string, query),
			],
			[
				method,
				/^\/api\/v2\/pages\/(\d+)\/properties(?:\/(\d+))?$/,
				pageRoute((page, m) => this.#properties(page, method, m[2], request)),
			],
			[
				"GET",
				/^\/api\/v2\/pages\/(\d+)\/attachments$/,
				pageRoute((page) => {
					const results = page.attachments
						.filter((a) => a.status === "current")
						.map((a) => ({ id: a.id, title: a.title, comment: a.comment }));
					return json(200, { results, _links: {} });
				}),
			],
			[
				"DELETE",
				/^\/api\/v2\/attachments\/(\w+)$/,
				(m) => {
					const attachment = this.current()
						.flatMap((page) => page.attachments)
						.find((a) => a.id === m[1] && a.status === "current");
					if (!attachment) return json(404, { message: "Attachment not found" });
					attachment.status = "trashed";
					return new Response(null, { status: 204 });
				},
			],
			[
				"PUT",
				/^\/rest\/api\/content\/(\d+)\/child\/attachment$/,
				(m) => this.#upload(m[1] as string, request),
			],
		];
		for (const [verb, pattern, handle] of routes) {
			const m = pattern.exec(path);
			if (verb === method && m) return handle([...m]);
		}
		return json(404, { message: `No fake route for ${method} ${path}` });
	}

	#listPages(query: URLSearchParams): Response {
		let pages = this.current().filter((page) => page.type === "page");
		const ids = query.get("id");
		if (ids) pages = pages.filter((page) => ids.split(",").includes(page.id));
		const title = query.get("title");
		if (title !== null) pages = pages.filter((page) => page.title === title);
		return json(200, { results: pages.map((page) => this.#pageJson(page)), _links: {} });
	}

	#createPage(body: {
		spaceId?: string;
		status?: string;
		title?: string;
		parentId?: string;
		body?: { representation?: string; value?: string };
	}): Response {
		if (body.spaceId !== SPACE || !body.title || body.body?.representation !== "storage") {
			return json(400, { message: "Invalid page" });
		}
		if (this.#titleTaken(body.title)) {
			return json(400, { errors: [{ title: "A page with this title already exists" }] });
		}
		if (!body.parentId || !this.#currentPage(body.parentId)) {
			return json(404, { message: "Parent not found" });
		}
		const id = this.addPage({ title: body.title, parentId: body.parentId });
		const page = this.pages.get(id) as FakePage;
		page.body = body.body.value ?? "";
		return json(200, this.#pageJson(page));
	}

	#updatePage(
		page: FakePage,
		body: {
			title?: string;
			parentId?: string;
			body?: { value?: string };
			version?: { number?: number };
		},
	): Response {
		if (body.version?.number !== page.version + 1) {
			return json(409, { message: "Version conflict" });
		}
		if (!body.title || this.#titleTaken(body.title, page.id)) {
			return json(400, { errors: [{ title: "A page with this title already exists" }] });
		}
		if (body.parentId && !this.#currentPage(body.parentId)) {
			return json(404, { message: "Parent not found" });
		}
		page.title = body.title;
		page.body = body.body?.value ?? "";
		page.parentId = body.parentId ?? page.parentId;
		page.version++;
		page.editorId = ACCOUNT;
		return json(200, this.#pageJson(page));
	}

	#descendants(id: string, query: URLSearchParams): Response {
		const depth = Number(query.get("depth") ?? 2);
		const limit = Number(query.get("limit") ?? 25);
		const cursor = Number(query.get("cursor") ?? 0);
		const all: Array<{ page: FakePage; depth: number }> = [];
		const walk = (parentId: string, level: number) => {
			if (level > depth) return;
			for (const child of this.childrenOf(parentId)) {
				all.push({ page: child, depth: level });
				walk(child.id, level + 1);
			}
		};
		walk(id, 1);
		const slice = all.slice(cursor, cursor + limit);
		const next =
			cursor + limit < all.length
				? `/wiki/api/v2/pages/${id}/descendants?depth=${depth}&limit=${limit}&cursor=${cursor + limit}`
				: undefined;
		const results = slice.map(({ page, depth: level }) => ({
			id: page.id,
			status: page.status,
			title: page.title,
			type: page.type,
			parentId: page.parentId,
			depth: level,
		}));
		return json(200, { results, _links: next ? { next } : {} });
	}

	async #properties(
		page: FakePage,
		method: string,
		propertyId: string | undefined,
		request: Request,
	): Promise<Response> {
		if (method === "GET" && !propertyId) {
			const results = page.properties.map((p) => ({
				id: p.id,
				key: p.key,
				value: p.value,
				version: { number: p.version },
			}));
			return json(200, { results, _links: {} });
		}
		const body = (await request.json()) as {
			key: string;
			value: unknown;
			version?: { number: number };
		};
		if (method === "POST" && !propertyId) {
			if (page.properties.some((p) => p.key === body.key)) {
				return json(409, { message: "Property key already exists" });
			}
			const created = { id: this.#id(), key: body.key, value: body.value, version: 1 };
			page.properties.push(created);
			return json(200, { ...created, version: { number: 1 } });
		}
		const property = page.properties.find((p) => p.id === propertyId);
		if (method === "PUT" && property) {
			if (body.version?.number !== property.version + 1) {
				return json(409, { message: "Version conflict" });
			}
			property.value = body.value;
			property.version++;
			return json(200, { ...property, version: { number: property.version } });
		}
		return json(404, { message: "Property not found" });
	}

	async #upload(pageId: string, request: Request): Promise<Response> {
		if (request.headers.get("X-Atlassian-Token") !== "nocheck") {
			return json(403, { message: "XSRF check failed" });
		}
		const page = this.#currentPage(pageId);
		if (!page) return json(404, { message: "Page not found" });
		const form = await request.formData();
		const file = form.get("file");
		if (!(file instanceof File)) return json(400, { message: "No file" });
		const bytes = new Uint8Array(await file.arrayBuffer());
		const comment = String(form.get("comment") ?? "");
		const existing = page.attachments.find((a) => a.title === file.name && a.status === "current");
		if (existing) {
			existing.bytes = bytes;
			existing.comment = comment;
		} else {
			page.attachments.push({
				id: `att${this.#id()}`,
				title: file.name,
				comment,
				bytes,
				status: "current",
			});
		}
		if (this.uploadBumpsVersion) {
			page.version++;
			page.editorId = ACCOUNT;
		}
		return json(200, { results: [] });
	}

	#currentPage(id: string): FakePage | undefined {
		const page = this.pages.get(id);
		return page?.status === "current" && page.type === "page" ? page : undefined;
	}

	#titleTaken(title: string, exceptId?: string): boolean {
		return this.current().some(
			(page) => page.id !== exceptId && page.title.toLowerCase() === title.toLowerCase(),
		);
	}

	#pageJson(page: FakePage) {
		return {
			id: page.id,
			status: page.status,
			title: page.title,
			spaceId: SPACE,
			parentId: page.parentId,
			authorId: page.authorId,
			version: { number: page.version, authorId: page.editorId },
			_links: { base: BASE_URL, webui: `/spaces/DOCS/pages/${page.id}` },
		};
	}

	#id(): string {
		return String(this.#nextId++);
	}
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}
