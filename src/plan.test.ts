import { describe, expect, it } from "vitest";
import {
	type Owner,
	plan,
	type Remote,
	type RemoteNode,
	type RemotePage,
	type Step,
	titlesToCheck,
} from "./plan";
import type { DesiredPage } from "./source";

const ROOT = "100";
const BOT = "bot-account";

function want(source: string, title: string, digest = `d-${source}`): DesiredPage {
	const slash = source.lastIndexOf("/");
	return {
		source,
		parentSource: slash === -1 ? null : source.slice(0, slash),
		title,
		body: "",
		attachments: [],
		digest,
		file: `docs/${source}`,
	};
}

function owner(source: string, digest: string | null = `d-${source}`, version = 1): Owner {
	return digest === null
		? { source, root: null, digest: null, version: null, property: null }
		: { source, root: ROOT, digest, version, property: null };
}

function page(
	id: string,
	parentId: string,
	title: string,
	own: Owner | null,
	version = 1,
): RemotePage {
	return { id, parentId, title, version, authorId: BOT, editorId: BOT, owner: own };
}

/** A tree whose items are these pages, plus `others` that are not pages, such as folders. */
function remote(pages: RemotePage[] = [], others: RemoteNode[] = []): Remote {
	const nodes = [...pages.map(({ id, parentId }) => ({ id, parentId })), ...others];
	return { rootId: ROOT, accountId: BOT, pages, nodes };
}

function label(step: Step): string {
	switch (step.kind) {
		case "create":
			return `create ${step.page.source}`;
		case "adopt":
		case "update":
			return `${step.kind} ${step.page.source} ${step.target.id} ${step.reason}`;
		case "skip":
			return `skip ${step.page.source} ${step.target.id}`;
		case "delete":
			return `delete ${step.target.id}`;
		case "keep":
			return `keep ${step.target.id} ${step.reason}`;
	}
}

function summary(desired: DesiredPage[], current: Remote, holders = new Map<string, string>()) {
	const result = plan(desired, current, holders);
	return { steps: result.steps.map(label), errors: result.errors };
}

describe("plan", () => {
	it("creates every page parent-first on the first run", () => {
		expect(
			summary([want("guides", "Guides"), want("guides/a.md", "A"), want("b.md", "B")], remote()),
		).toEqual({ steps: ["create guides", "create guides/a.md", "create b.md"], errors: [] });
	});

	it("skips a page whose digest, parent and version match", () => {
		expect(summary([want("a.md", "A")], remote([page("1", ROOT, "A", owner("a.md"))]))).toEqual({
			steps: ["skip a.md 1"],
			errors: [],
		});
	});

	it("updates a page whose digest changed", () => {
		expect(
			summary([want("a.md", "A", "new")], remote([page("1", ROOT, "A", owner("a.md", "old"))]))
				.steps,
		).toEqual(["update a.md 1 content"]);
	});

	it("updates a page that someone moved to another parent", () => {
		expect(
			summary([want("a.md", "A")], remote([page("1", "999", "A", owner("a.md"))])).steps,
		).toEqual(["update a.md 1 parent"]);
	});

	it("updates a page that someone edited in Confluence", () => {
		expect(
			summary([want("a.md", "A")], remote([page("1", ROOT, "A", owner("a.md", "d-a.md", 3), 4)]))
				.steps,
		).toEqual(["update a.md 1 drift"]);
	});

	it("adopts a page from confluence-markdown-sync-action by its filePath", () => {
		expect(
			summary([want("a.md", "A")], remote([page("1", ROOT, "A", owner("a.md", null))])).steps,
		).toEqual(["adopt a.md 1 legacy"]);
	});

	it("adopts an orphan: same parent, same title ignoring case, written by this account", () => {
		expect(
			summary([want("a.md", "Setup")], remote([page("1", ROOT, "SETUP", null)])).steps,
		).toEqual(["adopt a.md 1 orphan"]);
	});

	it("never adopts, updates or deletes an unowned page written by someone else", () => {
		const human = { ...page("1", ROOT, "Setup", null), authorId: "a-person" };
		expect(summary([want("a.md", "Setup")], remote([human]), new Map([["setup", "1"]]))).toEqual({
			steps: ["create a.md"],
			errors: ['Cannot give docs/a.md the title "Setup": page 1 in the space already has it.'],
		});
	});

	it("deletes owned pages that no file asks for, children first", () => {
		expect(
			summary(
				[],
				remote([
					page("1", ROOT, "Old", owner("old")),
					page("2", "1", "Child", owner("old/child.md")),
				]),
			).steps,
		).toEqual(["delete 2", "delete 1"]);
	});

	it("keeps an owned page that has a child page this action does not own", () => {
		expect(
			summary([], remote([page("1", ROOT, "Old", owner("old.md")), page("2", "1", "Notes", null)]))
				.steps,
		).toEqual(["keep 1 children"]);
	});

	it("deletes before it creates, so a moved file can reuse its title", () => {
		const current = remote([
			page("9", ROOT, "Old", owner("old")),
			page("10", "9", "Setup", owner("old/setup.md")),
		]);
		expect(
			summary(
				[want("new", "New"), want("new/setup.md", "Setup")],
				current,
				new Map([["setup", "10"]]),
			),
		).toEqual({
			steps: ["delete 10", "delete 9", "create new", "create new/setup.md"],
			errors: [],
		});
	});

	it("updates a page after the creates when its new parent is created in the same run", () => {
		expect(
			summary(
				[want("a", "A"), want("a/x.md", "X")],
				remote([page("5", ROOT, "X", owner("a/x.md"))]),
			).steps,
		).toEqual(["create a", "update a/x.md 5 parent"]);
	});

	it("lets a create take a title that an owned page gives up in the same run", () => {
		const current = remote([page("7", ROOT, "Old", owner("x.md", "before"))]);
		expect(
			summary(
				[want("x.md", "New", "after"), want("y.md", "Old")],
				current,
				new Map([["old", "7"]]),
			),
		).toEqual({ steps: ["update x.md 7 content", "create y.md"], errors: [] });
	});

	it("reports two pages that claim the same source", () => {
		expect(
			summary(
				[want("a.md", "A")],
				remote([page("1", ROOT, "A", owner("a.md")), page("2", ROOT, "A 2", owner("a.md"))]),
			).errors,
		).toEqual(["Pages 1 and 2 both belong to a.md. Move one of them to the trash in Confluence."]);
	});
});

describe("plan: ownership", () => {
	it("never matches or deletes pages of a configuration whose root is inside this tree", () => {
		const person = { ...page("2", ROOT, "Team B", null), authorId: "a-person" };
		const foreign = page("3", "2", "B page", { ...owner("x.md"), root: "2" });
		expect(summary([want("x.md", "X")], remote([person, foreign]))).toEqual({
			steps: ["create x.md"],
			errors: [],
		});
	});

	it("keeps owning pages whose recorded root is not in the tree, after a move of the root", () => {
		const moved = page("1", ROOT, "A", { ...owner("a.md"), root: "old-root" });
		expect(summary([want("a.md", "A")], remote([moved])).steps).toEqual(["skip a.md 1"]);
	});

	it("keeps an owned page that has a folder or another non-page item under it", () => {
		expect(
			summary([], remote([page("1", ROOT, "Old", owner("old.md"))], [{ id: "f1", parentId: "1" }]))
				.steps,
		).toEqual(["keep 1 children"]);
	});

	it("keeps an owned page that another account created", () => {
		const forged = { ...page("1", ROOT, "Notes", owner("gone.md")), authorId: "a-person" };
		expect(summary([], remote([forged])).steps).toEqual(["keep 1 author"]);
	});

	it("updates a page whose latest version another account wrote", () => {
		const edited = { ...page("1", ROOT, "A", owner("a.md")), editorId: "a-person" };
		expect(summary([want("a.md", "A")], remote([edited])).steps).toEqual(["update a.md 1 drift"]);
	});
});

describe("plan: titles", () => {
	it("orders a chain of renames so each title is free when it is taken", () => {
		const current = remote([
			page("1", ROOT, "One", owner("a.md", "old-a")),
			page("2", ROOT, "Two", owner("b.md", "old-b")),
		]);
		expect(summary([want("a.md", "Two"), want("b.md", "Three")], current)).toEqual({
			steps: ["update b.md 2 content", "update a.md 1 content"],
			errors: [],
		});
	});

	it("reports two pages that swap titles before any write", () => {
		const current = remote([
			page("1", ROOT, "One", owner("a.md", "old-a")),
			page("2", ROOT, "Two", owner("b.md", "old-b")),
		]);
		expect(summary([want("a.md", "Two"), want("b.md", "One")], current).errors).toEqual([
			'Cannot give docs/a.md the title "Two": page 2 has it and takes a title from this page. Rename one of the two files in a separate change.',
		]);
	});

	it("reports a rename to a title that a page elsewhere in the space has", () => {
		const legacy = page("1", ROOT, "Folder / X", owner("a.md", null));
		expect(summary([want("a.md", "X")], remote([legacy]), new Map([["x", "77"]]))).toEqual({
			steps: ["adopt a.md 1 legacy"],
			errors: ['Cannot give docs/a.md the title "X": page 77 in the space already has it.'],
		});
	});

	it("finds a title holder in the tree regardless of case", () => {
		const person = { ...page("5", ROOT, "SETUP", null), authorId: "a-person" };
		expect(summary([want("a.md", "Setup")], remote([person])).errors).toEqual([
			'Cannot give docs/a.md the title "Setup": page 5 in the space already has it.',
		]);
	});
});

describe("titlesToCheck", () => {
	it("returns the titles of the pages that the plan would create or rename", () => {
		const current = remote([
			page("1", ROOT, "A", owner("a.md")),
			page("2", ROOT, "Orphan", null),
			page("3", ROOT, "C", owner("c.md")),
		]);
		expect(
			titlesToCheck(
				[want("a.md", "A"), want("o.md", "Orphan"), want("b.md", "B"), want("c.md", "C2")],
				current,
			),
		).toEqual(["B", "C2"]);
	});
});
