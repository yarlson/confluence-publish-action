import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSource } from "./source";

let base: string;

/** Creates `files` under a new temporary directory and returns the workspace inside it. */
async function workspace(files: Record<string, string | Uint8Array>): Promise<string> {
	base = await realpath(await mkdtemp(join(tmpdir(), "source-test-")));
	const ws = join(base, "ws");
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(base, path)), { recursive: true });
		await writeFile(join(base, path), content);
	}
	await mkdir(ws, { recursive: true });
	return ws;
}

/** The PNG signature and IHDR chunk, which is all an image-size reader needs. */
function png(width: number, height: number, seed = 0): Uint8Array {
	const bytes = Buffer.alloc(33 + seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function read(ws: string, exclude: string[] = []) {
	const warnings: Array<[string, string, number]> = [];
	const pages = readSource({
		workspace: ws,
		sourcePath: "docs",
		exclude,
		warn: (message, file, line) => warnings.push([message, file, line]),
	});
	return { pages, warnings };
}

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("readSource", () => {
	it("returns folders and files parents-first, with titles from H1, file name and folder name", async () => {
		const ws = await workspace({
			"ws/docs/intro.md": "# Welcome\n\nHi",
			"ws/docs/guides/setup.md": "# Setup\n\nSteps",
			"ws/docs/guides/advanced/tuning.md": "No heading",
			"ws/docs/empty-dir/notes.txt": "not markdown",
		});
		const pages = await read(ws).pages;
		expect(
			pages.map(({ source, parentSource, title, file }) => ({ source, parentSource, title, file })),
		).toEqual([
			{ source: "guides", parentSource: null, title: "Guides", file: "docs/guides" },
			{
				source: "guides/advanced",
				parentSource: "guides",
				title: "Advanced",
				file: "docs/guides/advanced",
			},
			{
				source: "guides/advanced/tuning.md",
				parentSource: "guides/advanced",
				title: "tuning",
				file: "docs/guides/advanced/tuning.md",
			},
			{
				source: "guides/setup.md",
				parentSource: "guides",
				title: "Setup",
				file: "docs/guides/setup.md",
			},
			{ source: "intro.md", parentSource: null, title: "Welcome", file: "docs/intro.md" },
		]);
		expect(pages[0]?.body).toBe('<ac:structured-macro ac:name="children" />');
		expect(pages[4]?.body).toBe("<p>Hi</p>");
	});

	it("prefixes every member of a title collision with its parent folder", async () => {
		const ws = await workspace({
			"ws/docs/api/introduction.md": "# Introduction",
			"ws/docs/guide/introduction.md": "# Introduction",
		});
		const titles = (await read(ws).pages).map((page) => page.title);
		expect(titles).toEqual(["Api", "Api / Introduction", "Guide", "Guide / Introduction"]);
	});

	it("treats titles that differ only in case as a collision", async () => {
		const ws = await workspace({
			"ws/docs/a/x.md": "# Setup",
			"ws/docs/b/y.md": "# SETUP",
		});
		const titles = (await read(ws).pages).map((page) => page.title);
		expect(titles).toEqual(["A", "A / Setup", "B", "B / SETUP"]);
	});

	it("keeps a root-level title and prefixes the nested one", async () => {
		const ws = await workspace({
			"ws/docs/intro.md": "# Intro",
			"ws/docs/more/intro.md": "# Intro",
		});
		const titles = (await read(ws).pages).map((page) => page.title);
		expect(titles).toEqual(["Intro", "More", "More / Intro"]);
	});

	it("fails when a collision cannot be resolved with folder prefixes", async () => {
		const ws = await workspace({ "ws/docs/x.md": "# Same", "ws/docs/y.md": "# Same" });
		await expect(read(ws).pages).rejects.toThrow(
			'Pages have the same title "Same": x.md, y.md. Give one of them a different H1.',
		);
	});

	it("fails when a title is longer than 255 characters", async () => {
		const ws = await workspace({ "ws/docs/long.md": `# ${"x".repeat(256)}` });
		await expect(read(ws).pages).rejects.toThrow(
			"Title of long.md is 256 characters; Confluence allows 255.",
		);
	});

	it("skips excluded paths and folders left without Markdown", async () => {
		const ws = await workspace({
			"ws/docs/keep.md": "# Keep",
			"ws/docs/drafts/wip.md": "# WIP",
		});
		const sources = (await read(ws, ["drafts/**"]).pages).map((page) => page.source);
		expect(sources).toEqual(["keep.md"]);
	});

	it("links to another page by title and maps the heading anchor", async () => {
		const ws = await workspace({
			"ws/docs/guides/setup.md": "# Setup\n\n## Install It",
			"ws/docs/intro.md":
				"# Intro\n\nSee [setup](guides/setup.md#install-it) and [guides](guides/).",
		});
		const intro = (await read(ws).pages).find((page) => page.source === "intro.md");
		expect(intro?.body).toBe(
			'<p>See <ac:link ac:anchor="Install-It"><ri:page ri:content-title="Setup" /><ac:link-body>setup</ac:link-body></ac:link>' +
				' and <ac:link><ri:page ri:content-title="Guides" /><ac:link-body>guides</ac:link-body></ac:link>.</p>',
		);
	});

	it("keeps a link to a file that is not published and warns with its location", async () => {
		const ws = await workspace({ "ws/docs/intro.md": "# Intro\n\nSee [missing](nope.md)." });
		const { pages, warnings } = read(ws);
		expect((await pages)[0]?.body).toBe('<p>See <a href="nope.md">missing</a>.</p>');
		expect(warnings).toEqual([["Link target is not published: nope.md", "docs/intro.md", 3]]);
	});

	it("rejects an image that resolves outside the workspace", async () => {
		const ws = await workspace({
			"secret.png": png(10, 10),
			"ws/docs/a.md": "![x](../../secret.png)",
		});
		await expect(read(ws).pages).rejects.toThrow(
			"Image ../../secret.png in docs/a.md resolves outside the workspace",
		);
	});

	it("rejects a symlinked image whose target is outside the workspace", async () => {
		const ws = await workspace({
			"secret.png": png(10, 10),
			"ws/docs/a.md": "![x](link.png)",
		});
		await symlink(join(base, "secret.png"), join(ws, "docs/link.png"));
		await expect(read(ws).pages).rejects.toThrow(
			"Image link.png in docs/a.md resolves outside the workspace",
		);
	});

	it("warns about a missing image and renders its alt text", async () => {
		const ws = await workspace({ "ws/docs/a.md": "![Diagram](gone.png)" });
		const { pages, warnings } = read(ws);
		expect((await pages)[0]?.body).toBe("<p>Diagram</p>");
		expect(warnings).toEqual([["Image not found: gone.png", "docs/a.md", 1]]);
	});

	it("names attachments by basename, prefixes a clash with a hash, and caps the width at 760", async () => {
		const wide = png(1000, 500);
		const narrow = png(300, 100, 1);
		const ws = await workspace({
			"ws/docs/one/logo.png": wide,
			"ws/docs/two/logo.png": narrow,
			"ws/docs/a.md": "![a](one/logo.png) ![b](two/logo.png) ![c](one/logo.png)",
		});
		const page = (await read(ws).pages)[0];
		const second = `${sha256(narrow).slice(0, 8)}-logo.png`;
		expect(page?.attachments).toEqual([
			{ name: "logo.png", path: join(ws, "docs/one/logo.png"), sha256: sha256(wide) },
			{ name: second, path: join(ws, "docs/two/logo.png"), sha256: sha256(narrow) },
		]);
		expect(page?.body).toBe(
			'<p><ac:image ac:alt="a" ac:width="760"><ri:attachment ri:filename="logo.png" /></ac:image> ' +
				`<ac:image ac:alt="b" ac:width="300"><ri:attachment ri:filename="${second}" /></ac:image> ` +
				'<ac:image ac:alt="c" ac:width="760"><ri:attachment ri:filename="logo.png" /></ac:image></p>',
		);
	});

	it("gives the same digests for the same tree and a new digest when an image changes", async () => {
		const ws = await workspace({
			"ws/docs/a.md": "![a](logo.png)",
			"ws/docs/logo.png": png(10, 10),
		});
		const first = (await read(ws).pages)[0]?.digest;
		expect((await read(ws).pages)[0]?.digest).toBe(first);
		await writeFile(join(ws, "docs/logo.png"), png(10, 10, 1));
		expect((await read(ws).pages)[0]?.digest).not.toBe(first);
	});

	it("rejects a source-path outside the workspace", async () => {
		const ws = await workspace({ "outside/a.md": "# A" });
		await expect(
			readSource({ workspace: ws, sourcePath: "../outside", exclude: [], warn: () => {} }),
		).rejects.toThrow('source-path "../outside" is outside the workspace');
	});

	it("rejects a source-path that is not a directory", async () => {
		const ws = await workspace({ "ws/docs": "a file" });
		await expect(read(ws).pages).rejects.toThrow('source-path "docs" is not a directory');
	});
});
