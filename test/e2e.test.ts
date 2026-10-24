import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_KEY } from "../src/confluence";
import { type Config, publish, type Report } from "../src/publish";
import { ACCOUNT, BASE_URL, EMAIL, FakeConfluence, type FakePage, TOKEN } from "./fake-confluence";

let fake: FakeConfluence;
let workspace: string;
let warnings: string[];

async function files(entries: Record<string, string | Uint8Array>) {
	for (const [path, content] of Object.entries(entries)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content);
	}
}

function run(overrides: Partial<Config> = {}): Promise<Report> {
	return publish(
		{
			confluenceUrl: BASE_URL,
			rootPageId: fake.rootId,
			email: EMAIL,
			apiToken: TOKEN,
			workspace,
			sourcePath: "docs",
			excludePatterns: [],
			dryRun: false,
			...overrides,
		},
		{
			fetch: fake.fetch,
			sleep: async () => {},
			log: { info: () => {}, warning: (message) => warnings.push(message) },
		},
	);
}

/** The page tree under the root as nested titles. */
function tree(parentId = fake.rootId): unknown[] {
	return fake.childrenOf(parentId).map((page) => {
		const children = tree(page.id);
		return children.length > 0 ? { [page.title]: children } : page.title;
	});
}

function byTitle(title: string): FakePage {
	const page = fake.current().find((p) => p.title === title);
	if (!page) throw new Error(`no page titled ${title}`);
	return page;
}

function stepKinds(report: Report): string[] {
	return report.steps.map((step) => step.kind);
}

beforeEach(async () => {
	fake = new FakeConfluence();
	workspace = await realpath(await mkdtemp(join(tmpdir(), "e2e-")));
	warnings = [];
	await files({
		"docs/guides/setup.md": "# Setup\n\n![logo](img/logo.png)\n\n## Install",
		"docs/guides/img/logo.png": "logo-v1",
		"docs/intro.md": "# Intro\n\nRead [setup](guides/setup.md#install).",
	});
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

describe("publish", () => {
	it("creates the tree parents first, with bodies, attachments and ownership", async () => {
		const report = await run();
		expect(stepKinds(report)).toEqual(["create", "create", "create"]);
		expect(report.applied?.error).toBeUndefined();
		expect(tree()).toEqual([{ Guides: ["Setup"] }, "Intro"]);
		expect(byTitle("Intro").body).toBe(
			'<p>Read <ac:link ac:anchor="Install"><ri:page ri:content-title="Setup" /><ac:link-body>setup</ac:link-body></ac:link>.</p>',
		);
		expect(
			byTitle("Setup").attachments.map((a) => [a.title, new TextDecoder().decode(a.bytes)]),
		).toEqual([["logo.png", "logo-v1"]]);
		expect(byTitle("Setup").properties.find((p) => p.key === OWNER_KEY)?.value).toMatchObject({
			v: 1,
			source: "guides/setup.md",
		});
	});

	it("makes no writes on a second run, within the read budget", async () => {
		await run();
		fake.requests.length = 0;
		const report = await run();
		expect(stepKinds(report)).toEqual(["skip", "skip", "skip"]);
		expect(fake.writes()).toEqual([]);
		// 2·⌈P/250⌉ + P + 3 for P = 3 pages
		expect(fake.requests.length).toBeLessThanOrEqual(8);
	});

	it("updates only the changed page, and uploads only a changed image", async () => {
		await run();
		await files({
			"docs/guides/setup.md": "# Setup\n\n![logo](img/logo.png)\n\nNew text.\n\n## Install",
		});
		fake.requests.length = 0;
		expect(stepKinds(await run())).toEqual(["skip", "update", "skip"]);
		expect(fake.writes().filter((w) => w.includes("/child/attachment"))).toEqual([]);

		await files({ "docs/guides/img/logo.png": "logo-v2" });
		fake.requests.length = 0;
		expect(stepKinds(await run())).toEqual(["skip", "update", "skip"]);
		expect(fake.writes().filter((w) => w.includes("/child/attachment"))).toHaveLength(1);
		expect(new TextDecoder().decode(byTitle("Setup").attachments[0]?.bytes)).toBe("logo-v2");
	});

	it("deletes and creates a renamed file that keeps its title", async () => {
		await run();
		await rename(join(workspace, "docs/intro.md"), join(workspace, "docs/welcome.md"));
		const report = await run();
		expect(stepKinds(report)).toEqual(["delete", "skip", "skip", "create"]);
		expect(tree()).toEqual([{ Guides: ["Setup"] }, "Intro"]);
	});

	it("deletes a removed folder, children first", async () => {
		await run();
		const guides = byTitle("Guides").id;
		const setup = byTitle("Setup").id;
		await rm(join(workspace, "docs/guides"), { recursive: true });
		await run();
		expect(fake.writes().filter((w) => w.startsWith("DELETE /api/v2/pages/"))).toEqual([
			`DELETE /api/v2/pages/${setup}`,
			`DELETE /api/v2/pages/${guides}`,
		]);
		expect(tree()).toEqual(["Intro"]);
	});

	it("overwrites an edit made in Confluence and warns", async () => {
		await run();
		const intro = byTitle("Intro");
		intro.body = "<p>edited by hand</p>";
		intro.version++;
		const report = await run();
		expect(stepKinds(report)).toEqual(["skip", "skip", "update"]);
		expect(intro.body).toContain("Read ");
		expect(warnings).toEqual([expect.stringContaining("edited in Confluence")]);
	});

	it("adopts a page left by a run that stopped before its ownership property", async () => {
		fake.failNext((method, path) => method === "POST" && path.endsWith("/properties"), "network");
		const failed = await run();
		expect(failed.applied?.done).toHaveLength(0);
		expect(failed.applied?.error).toBeDefined();

		const report = await run();
		expect(report.steps.map((s) => (s.kind === "adopt" ? `adopt ${s.reason}` : s.kind))).toEqual([
			"adopt orphan",
			"create",
			"create",
		]);
		expect(report.applied?.error).toBeUndefined();
		expect(fake.current().filter((p) => p.title === "Guides")).toHaveLength(1);
	});

	it("finishes an interrupted create on the next run, even after the title changed", async () => {
		fake.failNext(
			(method, path) => method === "PUT" && path.endsWith("/child/attachment"),
			"network",
		);
		const failed = await run();
		expect(failed.applied?.error).toBeDefined();
		await files({ "docs/guides/setup.md": "# Installation\n\n![logo](img/logo.png)" });

		const report = await run();
		expect(report.applied?.error).toBeUndefined();
		expect(tree()).toEqual([{ Guides: ["Installation"] }, "Intro"]);
		expect(stepKinds(await run())).toEqual(["skip", "skip", "skip"]);
	});

	it("leaves alone the pages of a configuration whose root is inside this tree", async () => {
		await run();
		const teamB = fake.addPage({ title: "Team B", parentId: fake.rootId, authorId: "a-person" });
		const other = await realpath(await mkdtemp(join(tmpdir(), "e2e-other-")));
		await mkdir(join(other, "docs"));
		await writeFile(join(other, "docs/b.md"), "# B page");
		await run({ rootPageId: teamB, workspace: other });

		const report = await run();
		expect(stepKinds(report)).toEqual(["skip", "skip", "skip"]);
		expect(fake.childrenOf(teamB).map((page) => page.title)).toEqual(["B page"]);
		await rm(other, { recursive: true, force: true });
	});

	it("finds a page whose create response was lost, without a duplicate", async () => {
		fake.failNext((method, path) => method === "POST" && path === "/api/v2/pages", "lost");
		const report = await run();
		expect(report.applied?.error).toBeUndefined();
		expect(tree()).toEqual([{ Guides: ["Setup"] }, "Intro"]);
	});

	it("adopts legacy pages by their filePath property, in place", async () => {
		const guides = fake.addPage({
			title: "Guides",
			parentId: fake.rootId,
			properties: { filePath: "guides", contentHash: "old" },
		});
		const setup = fake.addPage({
			title: "Setup",
			parentId: guides,
			properties: { filePath: "guides/setup.md", contentHash: "old" },
		});
		const report = await run();
		expect(report.steps.map((s) => (s.kind === "adopt" ? `adopt ${s.reason}` : s.kind))).toEqual([
			"adopt legacy",
			"adopt legacy",
			"create",
		]);
		expect([byTitle("Guides").id, byTitle("Setup").id]).toEqual([guides, setup]);
		expect(stepKinds(await run())).toEqual(["skip", "skip", "skip"]);
	});

	it("never changes a page that it does not own", async () => {
		const notes = fake.addPage({
			title: "Team notes",
			parentId: fake.rootId,
			authorId: "a-person",
		});
		await run();
		await rm(join(workspace, "docs/intro.md"));
		await run();
		const page = fake.pages.get(notes);
		expect(page).toMatchObject({ status: "current", version: 1, properties: [] });
		expect(fake.requests.filter((r) => !r.startsWith("GET") && r.includes(notes))).toEqual([]);
	});

	it("refuses to run on a source folder without Markdown", async () => {
		await rm(join(workspace, "docs"), { recursive: true });
		await files({ "docs/readme.txt": "not markdown" });
		await expect(run()).rejects.toThrow('No Markdown files found in "docs"');
		expect(fake.requests).toEqual([]);
	});

	it("plans in a dry run without writing, and the real run does what it planned", async () => {
		const plan = await run({ dryRun: true });
		expect(fake.writes()).toEqual([]);
		expect(plan.applied).toBeUndefined();
		const real = await run();
		expect(stepKinds(real)).toEqual(stepKinds(plan));
		expect(real.applied?.done).toHaveLength(plan.steps.length);
	});

	it("stays within the read budget for 505 pages in 3 levels", async () => {
		await rm(join(workspace, "docs"), { recursive: true });
		const generated: Record<string, string> = {};
		for (let a = 0; a < 5; a++) {
			for (let b = 0; b < 5; b++) {
				for (let i = 0; i < 19; i++)
					generated[`docs/a${a}/b${b}/f${i}.md`] = `# Page ${a}-${b}-${i}`;
			}
		}
		await files(generated);
		const first = await run();
		expect(first.applied?.done).toHaveLength(505);
		fake.requests.length = 0;
		await run();
		expect(fake.writes()).toEqual([]);
		// 2·⌈505/250⌉ + 505 + 3
		expect(fake.requests.length).toBeLessThanOrEqual(514);
	});

	it("writes as the configured account", async () => {
		await run();
		expect(new Set(fake.current().map((page) => page.authorId))).toEqual(new Set([ACCOUNT]));
	});
});
