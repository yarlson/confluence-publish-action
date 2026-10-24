import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_URL, EMAIL, FakeConfluence, TOKEN } from "../test/fake-confluence";
import { readConfig, run } from "./action";

const valid = {
	"confluence-url": "https://example.atlassian.net/wiki/",
	"root-page-id": "123456",
	email: "bot@example.com",
	"api-token": "secret-token",
	"source-path": "docs",
	"exclude-patterns": "drafts/**, private/**\n**/old/**\n",
	"dry-run": "true",
};

function setInputs(inputs: Record<string, string>) {
	for (const [name, value] of Object.entries(inputs)) {
		vi.stubEnv(`INPUT_${name.toUpperCase()}`, value);
	}
}

describe("readConfig", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("parses valid inputs, trims the URL and splits excludes on commas and newlines", () => {
		setInputs(valid);
		expect(readConfig()).toEqual({
			confluenceUrl: "https://example.atlassian.net/wiki",
			rootPageId: "123456",
			email: "bot@example.com",
			apiToken: "secret-token",
			workspace: process.cwd(),
			sourcePath: "docs",
			excludePatterns: ["drafts/**", "private/**", "**/old/**"],
			dryRun: true,
		});
	});

	it("masks the API token in the log", () => {
		setInputs(valid);
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		readConfig();
		expect(write).toHaveBeenCalledWith(expect.stringContaining("::add-mask::secret-token"));
	});

	it.each([
		["https://example.atlassian.net", "confluence-url"],
		["http://example.atlassian.net/wiki", "confluence-url"],
		["not a url", "confluence-url"],
	])("rejects confluence-url %j", (url, input) => {
		setInputs({ ...valid, "confluence-url": url });
		expect(() => readConfig()).toThrow(input);
	});

	it("rejects a root-page-id that is not a number", () => {
		setInputs({ ...valid, "root-page-id": "DOCS" });
		expect(() => readConfig()).toThrow('root-page-id must be a numeric page ID; got "DOCS"');
	});

	it("requires email", () => {
		setInputs({ ...valid, email: "" });
		expect(() => readConfig()).toThrow("Input required and not supplied: email");
	});

	it("rejects an email without @", () => {
		setInputs({ ...valid, email: "bot" });
		expect(() => readConfig()).toThrow('email must be an email address; got "bot"');
	});

	it("rejects an empty source-path", () => {
		setInputs({ ...valid, "source-path": "" });
		expect(() => readConfig()).toThrow("source-path must not be empty");
	});
});

describe("run", () => {
	// core.summary keeps the file path from its first use, so every test shares one file.
	const summaryFile = join(tmpdir(), `action-test-summary-${process.pid}`);
	let fake: FakeConfluence;
	let dir: string;
	let stdout: string[];

	beforeEach(async () => {
		fake = new FakeConfluence();
		dir = await realpath(await mkdtemp(join(tmpdir(), "action-test-")));
		await mkdir(join(dir, "docs"));
		await writeFile(join(dir, "docs/a.md"), "# A");
		await writeFile(join(dir, "output"), "");
		await writeFile(summaryFile, "");
		stdout = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process, "cwd").mockReturnValue(dir);
		vi.stubGlobal("fetch", fake.fetch);
		vi.stubEnv("GITHUB_OUTPUT", join(dir, "output"));
		vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
		setInputs({
			"confluence-url": BASE_URL,
			"root-page-id": fake.rootId,
			email: EMAIL,
			"api-token": TOKEN,
			"source-path": "docs",
			"exclude-patterns": "",
			"dry-run": "false",
		});
	});
	afterAll(async () => {
		await rm(summaryFile, { force: true });
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.exitCode = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	it("sets the page counts as outputs and lists the steps in the job summary", async () => {
		await run();
		const output = await readFile(join(dir, "output"), "utf8");
		expect(output.match(/^pages-\w+(?=<<)|^\d+$/gm)).toEqual([
			"pages-created",
			"1",
			"pages-updated",
			"0",
			"pages-deleted",
			"0",
			"pages-skipped",
			"0",
		]);
		const page = fake.current().find((p) => p.title === "A");
		expect(await readFile(summaryFile, "utf8")).toContain(
			`<td>create</td><td><a href="${BASE_URL}/pages/viewpage.action?pageId=${page?.id}">A</a></td><td>a.md</td>`,
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("keeps an untrusted line break out of workflow commands and the job summary", async () => {
		await writeFile(join(dir, "docs/x\n::notice::injected.md"), "text");
		await run();
		expect(stdout.join("")).toContain('create x ::notice::injected.md as "x ::notice::injected"');
		expect(stdout.join("")).not.toMatch(/^::notice::/m);
		expect(await readFile(summaryFile, "utf8")).toContain("<td>x ::notice::injected.md</td>");
	});

	it("explains a root page that does not exist", async () => {
		vi.stubEnv("INPUT_ROOT-PAGE-ID", "999");
		await run();
		expect(stdout.join("")).toContain(
			"::error::GET /api/v2/pages/999 failed with 404: Page not found. Check root-page-id, and that the account can view that page.",
		);
		expect(process.exitCode).toBe(1);
	});

	it("names the step that failed and still writes the summary", async () => {
		fake.failNext((method, path) => method === "POST" && path === "/api/v2/pages", { status: 400 });
		await run();
		expect(stdout.join("")).toContain(
			'::error::create a.md as "A" failed: POST /api/v2/pages failed with 400: injected failure',
		);
		expect(await readFile(summaryFile, "utf8")).toContain("<td>create</td><td>A</td>");
		expect(process.exitCode).toBe(1);
	});
});
