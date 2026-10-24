import type { DesiredPage } from "./source";

/** The ownership property of a page that this action, or its predecessor, wrote. */
export interface Owner {
	source: string;
	/** Null for a page from confluence-markdown-sync-action, which stored only filePath. */
	digest: string | null;
	/** The page version after this action's last write; null for a legacy page. */
	version: number | null;
	/** The property to update next time; null when only the legacy property exists. */
	property: { id: string; version: number } | null;
}

export interface RemotePage {
	id: string;
	parentId: string;
	title: string;
	version: number;
	authorId: string;
	owner: Owner | null;
}

/** Every page under the root, and the account that this run writes as. */
export interface Remote {
	rootId: string;
	accountId: string;
	pages: RemotePage[];
}

export type Step =
	| { kind: "create"; page: DesiredPage }
	| { kind: "adopt"; page: DesiredPage; target: RemotePage; reason: "legacy" | "orphan" }
	| {
			kind: "update";
			page: DesiredPage;
			target: RemotePage;
			reason: "content" | "parent" | "drift";
	  }
	| { kind: "skip"; page: DesiredPage; target: RemotePage }
	| { kind: "delete"; target: RemotePage }
	/** An owned page that no file asks for, kept because it still has child pages. */
	| { kind: "keep"; target: RemotePage };

export interface Plan {
	steps: Step[];
	/** Problems that must stop the run before any write. */
	errors: string[];
}

type Match =
	| { kind: "owned"; target: RemotePage; owner: Owner }
	| { kind: "legacy" | "orphan"; target: RemotePage }
	| { kind: "new" };

/** Titles of the pages that the plan would create, to check against the rest of the space. */
export function newTitles(desired: DesiredPage[], remote: Remote): string[] {
	const { matches } = matchPages(desired, remote);
	return desired.filter((page) => matches.get(page.source)?.kind === "new").map((p) => p.title);
}

/**
 * Decides every write of a run. The steps come in an order that frees titles and creates parents
 * before a later step needs them: deletes (children first), steps on existing pages whose parent
 * exists, creates, then steps on existing pages whose parent is created in this run.
 *
 * @param titleHolders lower-case title to the ID of the page in the space that has it
 */
export function plan(
	desired: DesiredPage[],
	remote: Remote,
	titleHolders: Map<string, string>,
): Plan {
	const { matches, errors } = matchPages(desired, remote);
	const matched = new Set(
		[...matches.values()].flatMap((match) => (match.kind === "new" ? [] : [match.target.id])),
	);
	const unmatched = remote.pages.filter((page) => page.owner && !matched.has(page.id));
	const deleted = deletable(unmatched, remote.pages);

	const byId = new Map(remote.pages.map((page) => [page.id, page]));
	const depth = (page: RemotePage): number => {
		const parent = byId.get(page.parentId);
		return parent ? depth(parent) + 1 : 0;
	};
	const deletes: Step[] = unmatched
		.filter((page) => deleted.has(page.id))
		.sort((a, b) => depth(b) - depth(a))
		.map((target) => ({ kind: "delete", target }));
	const keeps: Step[] = unmatched
		.filter((page) => !deleted.has(page.id))
		.map((target) => ({ kind: "keep", target }));

	const freed = new Set(deleted);
	for (const page of desired) {
		const match = matches.get(page.source);
		if (match && match.kind !== "new" && !sameTitle(match.target.title, page.title)) {
			freed.add(match.target.id);
		}
	}

	const early: Step[] = [];
	const creates: Step[] = [];
	const late: Step[] = [];
	const created = new Set<string>();
	for (const page of desired) {
		const match = matches.get(page.source) as Match;
		if (match.kind === "new") {
			const holder = titleHolders.get(page.title.toLowerCase());
			if (holder !== undefined && !freed.has(holder)) {
				errors.push(
					`Cannot create "${page.title}" for ${page.file}: page ${holder} in the space already has this title.`,
				);
			}
			creates.push({ kind: "create", page });
			created.add(page.source);
			continue;
		}
		const step = existingStep(page, match, parentIdOf(page, matches, remote.rootId));
		const parentIsNew = page.parentSource !== null && created.has(page.parentSource);
		(parentIsNew ? late : early).push(step);
	}

	return { steps: [...deletes, ...early, ...creates, ...late, ...keeps], errors };
}

function matchPages(desired: DesiredPage[], remote: Remote) {
	const errors: string[] = [];
	const bySource = new Map<string, RemotePage>();
	for (const page of remote.pages) {
		if (!page.owner) continue;
		const other = bySource.get(page.owner.source);
		if (other) {
			errors.push(
				`Pages ${other.id} and ${page.id} both belong to ${page.owner.source}. Move one of them to the trash in Confluence.`,
			);
			continue;
		}
		bySource.set(page.owner.source, page);
	}

	const matches = new Map<string, Match>();
	const claimed = new Set<string>();
	for (const page of desired) {
		const owned = bySource.get(page.source);
		if (owned?.owner) {
			matches.set(
				page.source,
				owned.owner.digest === null
					? { kind: "legacy", target: owned }
					: { kind: "owned", target: owned, owner: owned.owner },
			);
			claimed.add(owned.id);
			continue;
		}
		// A page that a failed run created before it could write the ownership property.
		const parentId = parentIdOf(page, matches, remote.rootId);
		const orphan = remote.pages.find(
			(candidate) =>
				parentId !== undefined &&
				!candidate.owner &&
				!claimed.has(candidate.id) &&
				candidate.parentId === parentId &&
				candidate.authorId === remote.accountId &&
				sameTitle(candidate.title, page.title),
		);
		if (orphan) {
			matches.set(page.source, { kind: "orphan", target: orphan });
			claimed.add(orphan.id);
			continue;
		}
		matches.set(page.source, { kind: "new" });
	}
	return { matches, errors };
}

/** The ID of the page's parent, or undefined when the parent does not exist yet. */
function parentIdOf(
	page: DesiredPage,
	matches: Map<string, Match>,
	rootId: string,
): string | undefined {
	if (page.parentSource === null) return rootId;
	const parent = matches.get(page.parentSource);
	return parent && parent.kind !== "new" ? parent.target.id : undefined;
}

function existingStep(
	page: DesiredPage,
	match: Exclude<Match, { kind: "new" }>,
	parentId: string | undefined,
): Step {
	const { target } = match;
	if (match.kind !== "owned") return { kind: "adopt", page, target, reason: match.kind };
	if (match.owner.digest !== page.digest)
		return { kind: "update", page, target, reason: "content" };
	if (target.parentId !== parentId) return { kind: "update", page, target, reason: "parent" };
	if (match.owner.version !== null && match.owner.version !== target.version) {
		return { kind: "update", page, target, reason: "drift" };
	}
	return { kind: "skip", page, target };
}

/**
 * The unmatched owned pages that are safe to delete: those whose child pages are all deleted too.
 * What Confluence does with the children of a deleted page is not documented.
 */
function deletable(unmatched: RemotePage[], pages: RemotePage[]): Set<string> {
	const children = Map.groupBy(pages, (page) => page.parentId);
	const ids = new Set(unmatched.map((page) => page.id));
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of ids) {
			if ((children.get(id) ?? []).some((child) => !ids.has(child.id))) {
				ids.delete(id);
				changed = true;
			}
		}
	}
	return ids;
}

function sameTitle(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
