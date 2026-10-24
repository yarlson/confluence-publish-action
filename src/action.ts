import * as core from "@actions/core";
import { type Config, publish } from "./publish";

export function readConfig(): Config {
	const apiToken = core.getInput("api-token", { required: true });
	core.setSecret(apiToken);

	const confluenceUrl = core.getInput("confluence-url", { required: true });
	const url = URL.parse(confluenceUrl);
	const base = url?.href.replace(/\/+$/, "");
	if (url?.protocol !== "https:" || !base?.endsWith("/wiki")) {
		throw new Error(
			`confluence-url must be an https URL ending in /wiki, for example https://example.atlassian.net/wiki; got "${confluenceUrl}"`,
		);
	}

	const rootPageId = core.getInput("root-page-id", { required: true });
	if (!/^\d+$/.test(rootPageId)) {
		throw new Error(`root-page-id must be a numeric page ID; got "${rootPageId}"`);
	}

	const email = core.getInput("email", { required: true });
	if (!email.includes("@")) {
		throw new Error(`email must be an email address; got "${email}"`);
	}

	const sourcePath = core.getInput("source-path");
	if (!sourcePath) {
		throw new Error('source-path must not be empty; use "." for the workspace root');
	}

	return {
		confluenceUrl: base,
		rootPageId,
		email,
		apiToken,
		workspace: process.cwd(),
		sourcePath,
		excludePatterns: core
			.getInput("exclude-patterns")
			.split(/[,\n]/)
			.map((pattern) => pattern.trim())
			.filter(Boolean),
		dryRun: core.getBooleanInput("dry-run"),
	};
}

export async function run(): Promise<void> {
	try {
		await publish(readConfig());
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}
