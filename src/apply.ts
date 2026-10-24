import { type Confluence, PENDING_DIGEST } from "./confluence";
import type { Owner, Step } from "./plan";
import type { DesiredPage } from "./source";

export interface Target {
	confluence: Confluence;
	spaceId: string;
	rootId: string;
	accountId: string;
}

export interface Applied {
	/** The steps that finished, in order. */
	done: Step[];
	/** Source path to page ID, for every page that exists after the finished steps. */
	pageIds: Map<string, string>;
	/** The error that stopped the run at step `done.length`, if any. */
	error?: unknown;
}

/**
 * Runs the steps in order and stops at the first failure. Every page write ends with the ownership
 * property, after the body and the attachments. A failure before that leaves a page that the next
 * plan updates again; it never leaves a page that claims to be current.
 */
export async function apply(steps: Step[], target: Target): Promise<Applied> {
	const { confluence } = target;
	const pageIds = new Map<string, string>();
	for (const step of steps) {
		if (step.kind !== "create" && step.kind !== "delete" && step.kind !== "keep") {
			pageIds.set(step.page.source, step.target.id);
		}
	}
	const parentId = (page: DesiredPage): string => {
		if (page.parentSource === null) return target.rootId;
		const id = pageIds.get(page.parentSource);
		if (id === undefined) throw new Error(`Plan error: ${page.source} comes before its parent`);
		return id;
	};
	const finish = async (id: string, page: DesiredPage, property: Owner["property"]) => {
		await confluence.syncAttachments(id, page.attachments);
		const version = await confluence.pageVersion(id);
		const value = { root: target.rootId, source: page.source, digest: page.digest, version };
		await confluence.writeOwner(id, value, property);
	};

	const done: Step[] = [];
	for (const step of steps) {
		try {
			switch (step.kind) {
				case "create": {
					const id = await create(step.page, parentId(step.page), target);
					pageIds.set(step.page.source, id);
					// Owned from now on, so a run that stops here leaves a page the next plan updates,
					// whatever happens to its title or folder in between.
					const pending = { root: target.rootId, source: step.page.source, digest: PENDING_DIGEST };
					const property = await confluence.writeOwner(id, { ...pending, version: 0 }, null);
					await finish(id, step.page, property);
					break;
				}
				case "adopt":
				case "update":
					await confluence.updatePage({
						id: step.target.id,
						parentId: parentId(step.page),
						title: step.page.title,
						body: step.page.body,
						version: step.target.version,
					});
					await finish(step.target.id, step.page, step.target.owner?.property ?? null);
					break;
				case "delete":
					await confluence.deletePage(step.target.id);
					break;
				case "skip":
				case "keep":
					break;
			}
		} catch (error) {
			return { done, pageIds, error };
		}
		done.push(step);
	}
	return { done, pageIds };
}

/** Creates the page. When the create gets no response, the space shows whether it happened. */
async function create(page: DesiredPage, parentId: string, target: Target): Promise<string> {
	const created = await target.confluence.createPage({
		spaceId: target.spaceId,
		parentId,
		title: page.title,
		body: page.body,
	});
	if (created !== null) return created;

	const found = await target.confluence.findPage(target.spaceId, page.title);
	if (found && found.parentId === parentId && found.authorId === target.accountId) return found.id;
	throw new Error(
		`Creating "${page.title}" for ${page.file} got no response, and the page is not in Confluence. Run the workflow again.`,
	);
}
