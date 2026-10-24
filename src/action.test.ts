import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "./action";

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
