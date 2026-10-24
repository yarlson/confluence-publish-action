import * as core from "@actions/core";
import { ConfluenceError } from "./confluence";
import type { Step } from "./plan";
import { type Config, describe, publish, type Report } from "./publish";

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
	let config: Config | undefined;
	try {
		config = readConfig();
		const report = await publish(config, {
			log: {
				info: core.info,
				warning: (message, at) =>
					core.warning(message, at && { file: at.file, startLine: at.line }),
			},
		});
		const counted = report.applied?.done ?? report.steps;
		const count = (...kinds: Step["kind"][]) =>
			counted.filter((step) => kinds.includes(step.kind)).length;
		core.setOutput("pages-created", count("create"));
		core.setOutput("pages-updated", count("update", "adopt"));
		core.setOutput("pages-deleted", count("delete"));
		core.setOutput("pages-skipped", count("skip", "keep"));
		await writeSummary(report);

		const failed = report.applied?.error;
		if (failed !== undefined) {
			const step = report.steps[report.applied?.done.length ?? 0] as Step;
			core.setFailed(`${describe(step)} failed: ${explain(failed, config)}`);
		}
	} catch (error) {
		core.setFailed(explain(error, config));
	}
}

function explain(error: unknown, config: Config | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof ConfluenceError)) return message;
	if (error.status === 401) {
		return `${message}. Check email and api-token: the token must belong to that Atlassian account.`;
	}
	if (error.status === 403) {
		return `${message}. The account needs permission to view, create and delete pages in the space.`;
	}
	if (error.status === 404 && error.path === `/api/v2/pages/${config?.rootPageId}`) {
		return `${message}. Check root-page-id, and that the account can view that page.`;
	}
	if (error.status === 409) {
		return `${message}. The page changed during the run, or the space requires approval to publish. Run the workflow again.`;
	}
	return message;
}

async function writeSummary(report: Report): Promise<void> {
	const pageIds = report.applied?.pageIds;
	const link = (id: string | undefined, title: string) =>
		id
			? `<a href="${escapeHtml(`${report.webBase}/pages/viewpage.action?pageId=${id}`)}">${escapeHtml(title)}</a>`
			: escapeHtml(title);
	const rows = report.steps.map((step) => {
		if (step.kind === "delete" || step.kind === "keep") {
			return [
				step.kind,
				escapeHtml(step.target.title),
				escapeHtml(step.target.owner?.source ?? ""),
			];
		}
		const id = step.kind === "create" ? pageIds?.get(step.page.source) : step.target.id;
		return [step.kind, link(id, step.page.title), escapeHtml(step.page.source)];
	});
	await core.summary
		.addHeading(report.dryRun ? "Confluence publish plan (dry run)" : "Confluence publish", 2)
		.addTable([
			[
				{ data: "Step", header: true },
				{ data: "Page", header: true },
				{ data: "Source", header: true },
			],
			...rows,
		])
		.write();
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
