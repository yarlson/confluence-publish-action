/**
 * Checks the points that Atlassian does not document for Cloud against a real site. Runs only with
 * `npm run test:live`, which needs .env.test (see the README). Every page it creates goes under a
 * new temporary page below CONFLUENCE_PARENT_PAGE_ID and moves to the trash at the end.
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
	if (!value) throw new Error(`.env.test must set ${name}`);
	return value;
}

describe.skipIf(!live)("live Confluence Cloud", () => {
	const suffix = Date.now();
	const writes: string[] = [];
	const countingFetch: typeof fetch = (input, init) => {
		if (init?.method && init.method !== "GET") writes.push(`${init.method} ${String(input)}`);
		return fetch(input, init);
	};
	const log = { info: () => {}, warning: () => {} };
	let confluence: Confluence;
	let spaceId: string;
	let config: Config;

	async function get<T>(path: string): Promise<T> {
		const credentials = btoa(`${env("CONFLUENCE_EMAIL")}:${env("CONFLUENCE_API_TOKEN")}`);
		const response = await fetch(`${env("CONFLUENCE_URL")}${path}`, {
			headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
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
		const parentId = env("CONFLUENCE_PARENT_PAGE_ID");
		spaceId = (await get<{ spaceId: string }>(`/api/v2/pages/${parentId}`)).spaceId;
		const rootId = await confluence.createPage({
			spaceId,
			parentId,
			title: `confluence-publish-action live test ${suffix}`,
			body: "<p>Temporary page for a test run.</p>",
		});
		if (!rootId) throw new Error("creating the temporary root page got no response");

		const workspace = await realpath(await mkdtemp(join(tmpdir(), "live-")));
		const files: Record<string, string> = {
			"docs/guide/setup.md": `# Setup ${suffix}\n\n## Install It\n\nSteps.`,
			"docs/intro.md": [
				`# Intro ${suffix}`,
				"[setup](guide/setup.md#install-it) and [more](#more)",
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
		if (!config) return;
		const remote = await confluence.readRemote(config.rootPageId);
		const depth = (id: string): number => {
			const page = remote.pages.find((p) => p.id === id);
			return page ? depth(page.parentId) + 1 : 0;
		};
		for (const page of [...remote.pages].sort((a, b) => depth(b.id) - depth(a.id))) {
			await confluence.deletePage(page.id);
		}
		await confluence.deletePage(config.rootPageId);
		await rm(config.workspace, { recursive: true, force: true });
	}, 120_000);

	it("makes no writes on a second run", async () => {
		writes.length = 0;
		const second = await publish(config, { log, fetch: countingFetch });
		expect(second.steps.map((step) => step.kind)).toEqual(["skip", "skip", "skip"]);
		expect(writes).toEqual([]);
	}, 120_000);

	it("keeps page links, heading anchors and URL images as written", async () => {
		const page = await get<{ body: { storage: { value: string } } }>(
			`/api/v2/pages/${await pageId(`Intro ${suffix}`)}?body-format=storage`,
		);
		const body = page.body.storage.value;
		expect(body).toContain(`ri:content-title="Setup ${suffix}"`);
		expect(body).toContain('ac:anchor="Install-It"');
		expect(body).toContain('href="#More"');
		expect(body).toContain('ri:value="https://github.githubassets.com/favicons/favicon.png"');
	});

	it("creates pages that are not marked for the legacy editor", async () => {
		const properties = await get<{ results: Array<{ key: string; value: unknown }> }>(
			`/api/v2/pages/${await pageId(`Intro ${suffix}`)}/properties`,
		);
		const editor = properties.results.find((property) => property.key === "editor")?.value;
		expect([undefined, "v2"]).toContain(editor);
	});

	it("lets a new page reuse the title of a page in the trash", async () => {
		const page = {
			spaceId,
			parentId: config.rootPageId,
			title: `Trash ${suffix}`,
			body: "<p>x</p>",
		};
		const first = await confluence.createPage(page);
		if (!first) throw new Error("creating the first page got no response");
		await confluence.deletePage(first);
		await expect(confluence.createPage(page)).resolves.toMatch(/^\d+$/);
	});
});
