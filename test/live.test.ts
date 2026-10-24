/**
 * Checks the points that Atlassian does not document for Cloud against a real site. Runs only with
 * `npm run test:live`, which needs .env.test (see the README). Every page it creates goes under one
 * new temporary page at the top level of CONFLUENCE_SPACE_KEY, outside the homepage tree, so no
 * existing page gains a child. At the end it moves only those pages to the trash.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confluence } from "../src/confluence";
import { type Config, publish } from "../src/publish";

const live = process.env.CONFLUENCE_LIVE === "1";
if (live) process.loadEnvFile(new URL("../.env.test", import.meta.url));

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`.env.test or the environment must set ${name}`);
	return value;
}

/** A valid 1×1 PNG. */
const onePixelPng =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe.skipIf(!live)("live Confluence Cloud", () => {
	const suffix = Date.now();
	const folder = `guide-${suffix}`;
	const writes: string[] = [];
	const countingFetch: typeof fetch = (input, init) => {
		if (init?.method && init.method !== "GET") writes.push(`${init.method} ${String(input)}`);
		return fetch(input, init);
	};
	const log = { info: () => {}, warning: () => {} };
	let confluence: Confluence;
	let spaceId: string;
	let rootId: string | undefined;
	let workspace: string | undefined;
	let config: Config;

	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const credentials = btoa(`${env("CONFLUENCE_EMAIL")}:${env("CONFLUENCE_API_TOKEN")}`);
		const response = await fetch(`${env("CONFLUENCE_URL")}${path}`, {
			method,
			headers: {
				Authorization: `Basic ${credentials}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
		return (await response.json()) as T;
	}

	async function pageId(title: string): Promise<string> {
		const page = await confluence.findPage(spaceId, title);
		if (!page) throw new Error(`no page titled ${title}`);
		return page.id;
	}

	beforeAll(async () => {
		confluence = new Confluence({
			baseUrl: env("CONFLUENCE_URL"),
			email: env("CONFLUENCE_EMAIL"),
			token: env("CONFLUENCE_API_TOKEN"),
		});
		const key = env("CONFLUENCE_SPACE_KEY");
		const spaces = await call<{ results: Array<{ id: string }> }>(
			"GET",
			`/api/v2/spaces?keys=${key}`,
		);
		const space = spaces.results[0];
		if (!space) throw new Error(`space ${key} not found`);
		spaceId = space.id;
		rootId = (
			await call<{ id: string }>("POST", "/api/v2/pages?root-level=true", {
				spaceId,
				status: "current",
				title: `confluence-publish-action live test ${suffix}`,
				body: {
					representation: "storage",
					value: "<p>Temporary page for a test run. It moves to the trash when the run ends.</p>",
				},
			})
		).id;

		workspace = await realpath(await mkdtemp(join(tmpdir(), "live-")));
		const files: Record<string, string | Uint8Array> = {
			[`docs/${folder}/setup.md`]: `# Setup ${suffix}\n\n## Install It\n\n![logo](img/logo.png)`,
			[`docs/${folder}/img/logo.png`]: Buffer.from(onePixelPng, "base64"),
			"docs/intro.md": [
				`# Intro ${suffix}`,
				`[setup](${folder}/setup.md#install-it) and [more](#more)`,
				"## More",
				"![logo](https://github.githubassets.com/favicons/favicon.png)",
			].join("\n\n"),
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(workspace, path)), { recursive: true });
			await writeFile(join(workspace, path), content);
		}
		config = {
			confluenceUrl: env("CONFLUENCE_URL"),
			rootPageId: rootId,
			email: env("CONFLUENCE_EMAIL"),
			apiToken: env("CONFLUENCE_API_TOKEN"),
			workspace,
			sourcePath: "docs",
			excludePatterns: [],
			dryRun: false,
		};
		const first = await publish(config, { log });
		if (first.applied?.error) throw first.applied.error;
	}, 120_000);

	afterAll(async () => {
		if (workspace) await rm(workspace, { recursive: true, force: true });
		if (!rootId) return;
		const remote = await confluence.readRemote(rootId);
		const parents = new Map(remote.nodes.map((node) => [node.id, node.parentId]));
		const depth = (id: string): number => {
			const parent = parents.get(id);
			return parent === undefined ? 0 : depth(parent) + 1;
		};
		const created = remote.pages.filter((page) => page.authorId === remote.accountId);
		for (const page of created.sort((a, b) => depth(b.id) - depth(a.id))) {
			await confluence.deletePage(page.id);
		}
		await confluence.deletePage(rootId);
	}, 120_000);

	it("makes no writes on a second run", async () => {
		writes.length = 0;
		const second = await publish(config, { log, fetch: countingFetch });
		expect(second.steps.map((step) => step.kind)).toEqual(["skip", "skip", "skip"]);
		expect(writes).toEqual([]);
	}, 120_000);

	it("keeps page links, heading anchors and URL images as written", async () => {
		const page = await call<{ body: { storage: { value: string } } }>(
			"GET",
			`/api/v2/pages/${await pageId(`Intro ${suffix}`)}?body-format=storage`,
		);
		const body = page.body.storage.value;
		expect(body).toContain(`ri:content-title="Setup ${suffix}"`);
		expect(body).toContain('ac:anchor="Install-It"');
		expect(body).toContain('href="#More"');
		expect(body).toContain('ri:value="https://github.githubassets.com/favicons/favicon.png"');
	});

	it("creates pages that are not marked for the legacy editor", async () => {
		const properties = await call<{ results: Array<{ key: string; value: unknown }> }>(
			"GET",
			`/api/v2/pages/${await pageId(`Intro ${suffix}`)}/properties`,
		);
		const editor = properties.results.find((property) => property.key === "editor")?.value;
		expect([undefined, "v2"]).toContain(editor);
	});

	it("finds a title holder whose title differs only in case", async () => {
		const holders = await confluence.titleHolders(spaceId, [`intro ${suffix}`.toUpperCase()]);
		expect(holders.get(`intro ${suffix}`)).toBe(await pageId(`Intro ${suffix}`));
	});

	it("uploads a local image as an attachment that carries its hash", async () => {
		const attachments = await call<{ results: Array<{ title: string; comment?: string }> }>(
			"GET",
			`/api/v2/pages/${await pageId(`Setup ${suffix}`)}/attachments`,
		);
		expect(attachments.results.map((a) => [a.title, a.comment?.startsWith("sha256:")])).toEqual([
			["logo.png", true],
		]);
	});

	it("lets a new page reuse the title of a page in the trash", async () => {
		const page = {
			spaceId,
			parentId: rootId as string,
			title: `Trash ${suffix}`,
			body: "<p>x</p>",
		};
		const first = await confluence.createPage(page);
		if (!first) throw new Error("creating the first page got no response");
		await confluence.deletePage(first);
		await expect(confluence.createPage(page)).resolves.toMatch(/^\d+$/);
	});

	it("updates a changed page, and the run after that writes nothing", async () => {
		await writeFile(join(config.workspace, "docs/intro.md"), `# Intro ${suffix}\n\nChanged text.`);
		const update = await publish(config, { log });
		expect(update.applied?.error).toBeUndefined();
		expect(update.steps.map((step) => step.kind)).toEqual(["skip", "skip", "update"]);
		writes.length = 0;
		const after = await publish(config, { log, fetch: countingFetch });
		expect(after.steps.map((step) => step.kind)).toEqual(["skip", "skip", "skip"]);
		expect(writes).toEqual([]);
	}, 120_000);
});
