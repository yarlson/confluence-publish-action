import { type Applied, apply } from "./apply";
import { Confluence } from "./confluence";
import { plan, type Step, titlesToCheck } from "./plan";
import { readSource } from "./source";

export interface Config {
	/** Base URL ending in `/wiki`, without a trailing slash. */
	confluenceUrl: string;
	rootPageId: string;
	email: string;
	apiToken: string;
	workspace: string;
	/** Relative to `workspace`. */
	sourcePath: string;
	excludePatterns: string[];
	dryRun: boolean;
}

export interface Log {
	info(message: string): void;
	warning(message: string, location?: { file: string; line?: number }): void;
}

export interface Dependencies {
	log: Log;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

export interface Report {
	dryRun: boolean;
	steps: Step[];
	/** Undefined in a dry run. */
	applied?: Applied;
	/** Site URL for page links. */
	webBase: string;
}

export async function publish(
	config: Config,
	{ log, fetch, sleep }: Dependencies,
): Promise<Report> {
	const desired = await readSource({
		workspace: config.workspace,
		sourcePath: config.sourcePath,
		exclude: config.excludePatterns,
		warn: (message, file, line) => log.warning(message, { file, line }),
	});
	if (desired.length === 0) {
		throw new Error(
			`No Markdown files found in "${config.sourcePath}". Nothing was changed, because publishing an empty folder would delete every published page.`,
		);
	}

	const confluence = new Confluence({
		baseUrl: config.confluenceUrl,
		email: config.email,
		token: config.apiToken,
		fetch,
		sleep,
	});
	const remote = await confluence.readRemote(config.rootPageId);
	const holders = await confluence.titleHolders(remote.spaceId, titlesToCheck(desired, remote));
	const { steps, errors } = plan(desired, remote, holders);
	if (errors.length > 0) {
		throw new Error(
			`Nothing was changed, because the plan has problems:\n- ${errors.join("\n- ")}`,
		);
	}

	for (const step of steps) {
		if (step.kind === "update" && step.reason === "drift") log.warning(describe(step));
		else log.info(describe(step));
	}
	const report = { dryRun: config.dryRun, steps, webBase: remote.webBase };
	if (config.dryRun) return report;

	const applied = await apply(steps, {
		confluence,
		spaceId: remote.spaceId,
		rootId: remote.rootId,
		accountId: remote.accountId,
	});
	return { ...report, applied };
}

export function describe(step: Step): string {
	switch (step.kind) {
		case "create":
			return `create ${step.page.source} as "${step.page.title}"`;
		case "adopt":
			return step.reason === "legacy"
				? `adopt ${step.page.source} (page ${step.target.id}, from its legacy filePath property)`
				: `adopt ${step.page.source} (page ${step.target.id}, left by an interrupted run)`;
		case "update": {
			const why = {
				content: "content changed",
				parent: "moved back under its parent",
				drift: "edited in Confluence; the file wins",
			}[step.reason];
			return `update ${step.page.source} (page ${step.target.id}, ${why})`;
		}
		case "skip":
			return `skip ${step.page.source} (page ${step.target.id})`;
		case "delete":
			return `delete ${step.target.owner?.source} (page ${step.target.id})`;
		case "keep":
			return step.reason === "children"
				? `keep ${step.target.owner?.source} (page ${step.target.id}): no file asks for it, but it still has child pages`
				: `keep ${step.target.owner?.source} (page ${step.target.id}): no file asks for it, but another account created it`;
	}
}
