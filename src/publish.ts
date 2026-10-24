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

export async function publish(_config: Config): Promise<never> {
	throw new Error("not implemented");
}
