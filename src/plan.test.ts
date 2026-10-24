import { describe, expect, it } from "vitest";
import { newTitles, type Owner, plan, type Remote, type RemotePage, type Step } from "./plan";
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
	return { source, digest, version: digest === null ? null : version, property: null };
}

function page(
	id: string,
	parentId: string,
	title: string,
	own: Owner | null,
	version = 1,
): RemotePage {
	return { id, parentId, title, version, authorId: BOT, owner: own };
}

function remote(...pages: RemotePage[]): Remote {
	return { rootId: ROOT, accountId: BOT, pages };
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
		case "keep":
			return `${step.kind} ${step.target.id}`;
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
		expect(summary([want("a.md", "A")], remote(page("1", ROOT, "A", owner("a.md"))))).toEqual({
			steps: ["skip a.md 1"],
			errors: [],
		});
	});

	it("updates a page whose digest changed", () => {
		expect(
			summary([want("a.md", "A", "new")], remote(page("1", ROOT, "A", owner("a.md", "old")))).steps,
		).toEqual(["update a.md 1 content"]);
	});

	it("updates a page that someone moved to another parent", () => {
		expect(
			summary([want("a.md", "A")], remote(page("1", "999", "A", owner("a.md")))).steps,
		).toEqual(["update a.md 1 parent"]);
	});

	it("updates a page that someone edited in Confluence", () => {
		expect(
			summary([want("a.md", "A")], remote(page("1", ROOT, "A", owner("a.md", "d-a.md", 3), 4)))
				.steps,
		).toEqual(["update a.md 1 drift"]);
	});

	it("adopts a page from confluence-markdown-sync-action by its filePath", () => {
		expect(
			summary([want("a.md", "A")], remote(page("1", ROOT, "A", owner("a.md", null)))).steps,
		).toEqual(["adopt a.md 1 legacy"]);
	});

	it("adopts an orphan: same parent, same title ignoring case, written by this account", () => {
		expect(summary([want("a.md", "Setup")], remote(page("1", ROOT, "SETUP", null))).steps).toEqual([
			"adopt a.md 1 orphan",
		]);
	});

	it("never adopts, updates or deletes an unowned page written by someone else", () => {
		const human = { ...page("1", ROOT, "Setup", null), authorId: "a-person" };
		expect(summary([want("a.md", "Setup")], remote(human), new Map([["setup", "1"]]))).toEqual({
			steps: ["create a.md"],
			errors: ['Cannot create "Setup" for docs/a.md: page 1 in the space already has this title.'],
		});
	});

	it("deletes owned pages that no file asks for, children first", () => {
		expect(
			summary(
				[],
				remote(
					page("1", ROOT, "Old", owner("old")),
					page("2", "1", "Child", owner("old/child.md")),
				),
			).steps,
		).toEqual(["delete 2", "delete 1"]);
	});

	it("keeps an owned page that has a child page this action does not own", () => {
		expect(
			summary([], remote(page("1", ROOT, "Old", owner("old.md")), page("2", "1", "Notes", null)))
				.steps,
		).toEqual(["keep 1"]);
	});

	it("deletes before it creates, so a moved file can reuse its title", () => {
		const current = remote(
			page("9", ROOT, "Old", owner("old")),
			page("10", "9", "Setup", owner("old/setup.md")),
		);
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
			summary([want("a", "A"), want("a/x.md", "X")], remote(page("5", ROOT, "X", owner("a/x.md"))))
				.steps,
		).toEqual(["create a", "update a/x.md 5 parent"]);
	});

	it("lets a create take a title that an owned page gives up in the same run", () => {
		const current = remote(page("7", ROOT, "Old", owner("x.md", "before")));
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
				remote(page("1", ROOT, "A", owner("a.md")), page("2", ROOT, "A 2", owner("a.md"))),
			).errors,
		).toEqual(["Pages 1 and 2 both belong to a.md. Move one of them to the trash in Confluence."]);
	});
});

describe("newTitles", () => {
	it("returns the titles of the pages that the plan would create", () => {
		const current = remote(page("1", ROOT, "A", owner("a.md")), page("2", ROOT, "Orphan", null));
		expect(
			newTitles([want("a.md", "A"), want("o.md", "Orphan"), want("b.md", "B")], current),
		).toEqual(["B"]);
	});
});
