import type { DesiredPage } from "./source";

/** The ownership property of a page, or a legacy `filePath` property. */
export interface Owner {
	source: string;
	/** The root page that the property was written under; null for a legacy page. */
	root: string | null;
	/** Null for a legacy page, which has only a filePath property. */
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
	/** The account that created the page. */
	authorId: string;
	/** The account that wrote the latest version. */
	editorId: string;
	owner: Owner | null;
}

/** Any item under the root: a page, or a folder, whiteboard, database or embed. */
export interface RemoteNode {
	id: string;
	parentId: string;
}

/** Everything under the root, and the account that this run writes as. */
export interface Remote {
	rootId: string;
	accountId: string;
	pages: RemotePage[];
	nodes: RemoteNode[];
}

type ExistingStep =
	| { kind: "adopt"; page: DesiredPage; target: RemotePage; reason: "legacy" | "orphan" }
	| {
			kind: "update";
			page: DesiredPage;
			target: RemotePage;
			reason: "content" | "parent" | "drift";
	  }
	| { kind: "skip"; page: DesiredPage; target: RemotePage };

export type Step =
	| { kind: "create"; page: DesiredPage }
	| ExistingStep
	| { kind: "delete"; target: RemotePage }
	/** An owned page that no file asks for, kept because deleting it is not safe. */
	| { kind: "keep"; target: RemotePage; reason: "children" | "author" };

export interface Plan {
	steps: Step[];
	/** Problems that must stop the run before any write. */
	errors: string[];
}

type Match =
	| { kind: "owned"; target: RemotePage; owner: Owner }
	| { kind: "legacy" | "orphan"; target: RemotePage }
	| { kind: "new" };

/** Titles that the plan would give to a page, to check against the rest of the space. */
export function titlesToCheck(desired: DesiredPage[], remote: Remote): string[] {
	const { matches } = matchPages(desired, remote);
	return desired
		.filter((page) => {
			const match = matches.get(page.source);
			return match?.kind === "new" || (match && !sameTitle(match.target.title, page.title));
		})
		.map((page) => page.title);
}

/**
 * Decides every write of a run. The steps come in an order that frees titles and creates parents
 * before a later step needs them: deletes (children first), steps on existing pages whose parent
 * exists (a rename after the rename that frees its title), creates, then steps on existing pages
 * whose parent is created in this run.
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
	const unmatched = remote.pages.filter((page) => ownerOf(page, remote) && !matched.has(page.id));
	const deleted = deletable(unmatched, remote);

	const parents = new Map(remote.nodes.map((node) => [node.id, node.parentId]));
	const depth = (id: string): number => {
		const parent = parents.get(id);
		return parent === undefined ? 0 : depth(parent) + 1;
	};
	const deletes: Step[] = unmatched
		.filter((page) => deleted.has(page.id))
		.sort((a, b) => depth(b.id) - depth(a.id))
		.map((target) => ({ kind: "delete", target }));
	const keeps: Step[] = unmatched
		.filter((page) => !deleted.has(page.id))
		.map((target) => ({
			kind: "keep",
			target,
			reason: target.authorId === remote.accountId ? "children" : "author",
		}));

	const early: ExistingStep[] = [];
	const creates: Step[] = [];
	const late: ExistingStep[] = [];
	const created = new Set<string>();
	for (const page of desired) {
		const match = matches.get(page.source) as Match;
		if (match.kind === "new") {
			creates.push({ kind: "create", page });
			created.add(page.source);
			continue;
		}
		const step = existingStep(page, match, parentIdOf(page, matches, remote.rootId), remote);
		const parentIsNew = page.parentSource !== null && created.has(page.parentSource);
		(parentIsNew ? late : early).push(step);
	}

	const holderOf = (title: string): string | undefined =>
		remote.pages.find((page) => sameTitle(page.title, title))?.id ??
		titleHolders.get(title.toLowerCase());
	const ordered = [...deletes, ...orderRenames(early, holderOf), ...creates, ...late];
	errors.push(...titleConflicts(ordered, holderOf));
	return { steps: [...ordered, ...keeps], errors };
}

/**
 * The page's owner, unless the property belongs to another configuration: one whose root page is
 * itself inside this tree. Such pages are never matched or deleted.
 */
function ownerOf(page: RemotePage, remote: Remote): Owner | null {
	const owner = page.owner;
	if (!owner || owner.root === null || owner.root === remote.rootId) return owner;
	return remote.nodes.some((node) => node.id === owner.root) ? null : owner;
}

function matchPages(desired: DesiredPage[], remote: Remote) {
	const errors: string[] = [];
	const bySource = new Map<string, { page: RemotePage; owner: Owner }>();
	for (const page of remote.pages) {
		const owner = ownerOf(page, remote);
		if (!owner) continue;
		const other = bySource.get(owner.source);
		if (other) {
			errors.push(
				`Pages ${other.page.id} and ${page.id} both belong to ${owner.source}. Move one of them to the trash in Confluence.`,
			);
			continue;
		}
		bySource.set(owner.source, { page, owner });
	}

	const matches = new Map<string, Match>();
	const claimed = new Set<string>();
	for (const page of desired) {
		const owned = bySource.get(page.source);
		if (owned) {
			matches.set(
				page.source,
				owned.owner.digest === null
					? { kind: "legacy", target: owned.page }
					: { kind: "owned", target: owned.page, owner: owned.owner },
			);
			claimed.add(owned.page.id);
			continue;
		}
		// A page that a run created and could not mark as its own before it stopped.
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
	remote: Remote,
): ExistingStep {
	const { target } = match;
	if (match.kind !== "owned") return { kind: "adopt", page, target, reason: match.kind };
	if (match.owner.digest !== page.digest) {
		return { kind: "update", page, target, reason: "content" };
	}
	if (target.parentId !== parentId) return { kind: "update", page, target, reason: "parent" };
	const edited =
		(match.owner.version !== null && match.owner.version !== target.version) ||
		target.editorId !== remote.accountId;
	if (edited) return { kind: "update", page, target, reason: "drift" };
	return { kind: "skip", page, target };
}

/**
 * The unmatched owned pages that are safe to delete: those that this account created, and whose
 * children are all deleted too. What Confluence does with the children of a deleted page is not
 * documented, and anyone who can edit a page can add an ownership property to it.
 */
function deletable(unmatched: RemotePage[], remote: Remote): Set<string> {
	const children = Map.groupBy(remote.nodes, (node) => node.parentId);
	const ids = new Set(
		unmatched.filter((page) => page.authorId === remote.accountId).map((page) => page.id),
	);
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

function renames(step: ExistingStep): boolean {
	return !sameTitle(step.target.title, step.page.title);
}

/** Moves each rename after the rename that frees the title it takes, where such an order exists. */
function orderRenames(
	steps: ExistingStep[],
	holderOf: (title: string) => string | undefined,
): ExistingStep[] {
	const blocker = (step: ExistingStep) => {
		if (!renames(step)) return undefined;
		const holder = holderOf(step.page.title);
		return steps.find((other) => other !== step && other.target.id === holder && renames(other));
	};
	const remaining = [...steps];
	const ordered: ExistingStep[] = [];
	while (remaining.length > 0) {
		const ready = remaining.findIndex((step) => {
			const before = blocker(step);
			return before === undefined || !remaining.includes(before);
		});
		// Titles that swap have no such order; titleConflicts() reports them.
		ordered.push(...remaining.splice(ready === -1 ? 0 : ready, 1));
	}
	return ordered;
}

/** Each title a step gives must be free when the step runs: unused, or freed by an earlier step. */
function titleConflicts(
	ordered: Step[],
	holderOf: (title: string) => string | undefined,
): string[] {
	const errors: string[] = [];
	const freed = new Set<string>();
	const renamed = new Set(
		ordered.flatMap((step) =>
			"page" in step && step.kind !== "create" && renames(step) ? [step.target.id] : [],
		),
	);
	for (const step of ordered) {
		if (step.kind === "delete") freed.add(step.target.id);
		if (step.kind === "delete" || step.kind === "keep") continue;
		const current = step.kind === "create" ? undefined : step.target;
		if (current && !renames(step as ExistingStep)) continue;

		const holder = holderOf(step.page.title);
		if (holder !== undefined && holder !== current?.id && !freed.has(holder)) {
			errors.push(
				renamed.has(holder)
					? `Cannot give ${step.page.file} the title "${step.page.title}": page ${holder} has it and takes a title from this page. Rename one of the two files in a separate change.`
					: `Cannot give ${step.page.file} the title "${step.page.title}": page ${holder} in the space already has it.`,
			);
		}
		if (current) freed.add(current.id);
	}
	return errors;
}

function sameTitle(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
