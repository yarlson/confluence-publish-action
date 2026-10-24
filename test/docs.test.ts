import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const actionYml = await readFile(new URL("../action.yml", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

/** Entries of a top-level `inputs:` or `outputs:` map, as `name|required|default`. */
function actionEntries(section: "inputs" | "outputs"): string[] {
	const block = actionYml.split(/^(?=\S)/m).find((part) => part.startsWith(`${section}:`)) ?? "";
	return [...block.matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n?)*)/gm)].map(([, name, body = ""]) => {
		if (section === "outputs") return name as string;
		const required = /^ {4}required: true$/m.test(body) ? "yes" : "no";
		const fallback = /^ {4}default: "(.*)"$/m.exec(body)?.[1] ?? "";
		return `${name}|${required}|${fallback}`;
	});
}

/** Rows of the first table under a `## heading`, with backticks removed. */
function readmeRows(heading: string): string[][] {
	const section = readme.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? "";
	return section
		.split("\n")
		.filter((line) => /^\| `/.test(line))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim().replace(/^`|`$/g, "")),
		);
}

describe("README", () => {
	it("documents every input with its required flag and default, as action.yml defines them", () => {
		const documented = readmeRows("Inputs").map(
			([name, required, fallback]) => `${name}|${required}|${fallback}`,
		);
		expect(documented).toEqual(actionEntries("inputs"));
	});

	it("documents every output that action.yml defines", () => {
		expect(readmeRows("Outputs").map(([name]) => name)).toEqual(actionEntries("outputs"));
	});
});
