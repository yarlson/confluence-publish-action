import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT, BASE_URL, EMAIL, FakeConfluence, TOKEN } from "../test/fake-confluence";
import { Confluence, ConfluenceError, OWNER_KEY } from "./confluence";

let fake: FakeConfluence;
let sleeps: number[];

function client(overrides: Partial<ConstructorParameters<typeof Confluence>[0]> = {}) {
	return new Confluence({
		baseUrl: BASE_URL,
		email: EMAIL,
		token: TOKEN,
		fetch: fake.fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 1,
		...overrides,
	});
}

beforeEach(() => {
	fake = new FakeConfluence();
	sleeps = [];
});

describe("retries", () => {
	it("waits for Retry-After on 429 and then succeeds", async () => {
		fake.failNext((method, path) => method === "GET" && path.endsWith(`/pages/${fake.rootId}`), {
			status: 429,
			retryAfter: 2,
		});
		const remote = await client().readRemote(fake.rootId);
		expect(remote.spaceId).toBe("9000");
		expect(sleeps).toEqual([2000]);
	});

	it("retries a GET on 503 with backoff and gives up after 4 attempts", async () => {
		for (let i = 0; i < 4; i++) fake.failNext((method) => method === "GET", { status: 503 });
		const error = await client()
			.readRemote(fake.rootId)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConfluenceError);
		expect((error as ConfluenceError).status).toBe(503);
		expect(sleeps).toEqual([500, 1000, 2000]);
	});

	it("returns null without a retry when a create gets no response", async () => {
		fake.failNext((method) => method === "POST", "network");
		const id = await client().createPage({
			spaceId: "9000",
			parentId: fake.rootId,
			title: "A",
			body: "<p>a</p>",
		});
		expect(id).toBeNull();
		expect(fake.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
	});

	it("does not retry an update that gets no response", async () => {
		const id = fake.addPage({ title: "A", parentId: fake.rootId });
		fake.failNext((method) => method === "PUT", "network");
		const error = await client()
			.updatePage({ id, parentId: fake.rootId, title: "A", body: "", version: 1 })
			.catch((e: unknown) => e);
		expect((error as ConfluenceError).status).toBeNull();
		expect(fake.requests.filter((r) => r.startsWith("PUT"))).toHaveLength(1);
	});
});

describe("errors", () => {
	it("names the method, path, status and Confluence message, and never the token", async () => {
		const error = await client({ token: "wrong-token" })
			.readRemote(fake.rootId)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConfluenceError);
		expect((error as ConfluenceError).status).toBe(401);
		expect((error as Error).message).toBe(
			`GET /api/v2/pages/${fake.rootId} failed with 401: Unauthorized`,
		);
		expect((error as Error).message).not.toContain("wrong-token");
	});

	it("reports the error titles that Confluence returns", async () => {
		const confluence = client();
		const page = { spaceId: "9000", parentId: fake.rootId, title: "Same", body: "" };
		await confluence.createPage(page);
		await expect(confluence.createPage(page)).rejects.toThrow(
			"POST /api/v2/pages failed with 400: A page with this title already exists",
		);
	});

	it("treats a delete of an attachment that is already gone as done", async () => {
		fake.failNext((method) => method === "DELETE", { status: 404 });
		const id = fake.addPage({ title: "A", parentId: fake.rootId });
		fake.pages.get(id)?.attachments.push({
			id: "att1",
			title: "old.png",
			comment: "sha256:x",
			bytes: new Uint8Array(),
			status: "current",
		});
		await expect(client().syncAttachments(id, [])).resolves.toEqual({ uploaded: 0, deleted: 1 });
	});

	it("treats a delete of a page that is already gone as done", async () => {
		const id = fake.addPage({ title: "A", parentId: fake.rootId });
		await client().deletePage(id);
		await client().deletePage(id);
		expect(fake.pages.get(id)?.status).toBe("trashed");
	});
});

describe("readRemote", () => {
	it("reads every page of a 600-page tree across result pages", async () => {
		for (let i = 0; i < 600; i++) fake.addPage({ title: `P${i}`, parentId: fake.rootId });
		const remote = await client().readRemote(fake.rootId);
		expect(remote.pages).toHaveLength(600);
		expect(fake.requests.filter((r) => r.includes("/descendants"))).toHaveLength(3);
		expect(fake.requests.filter((r) => r.startsWith("GET /api/v2/pages?id="))).toHaveLength(3);
	});

	it("reads pages deeper than the descendants depth limit of 10", async () => {
		let parent = fake.rootId;
		for (let i = 1; i <= 12; i++) parent = fake.addPage({ title: `L${i}`, parentId: parent });
		const remote = await client().readRemote(fake.rootId);
		expect(remote.pages.map((page) => page.title)).toEqual(
			Array.from({ length: 12 }, (_, i) => `L${i + 1}`),
		);
	});

	it("parses the ownership property, the legacy filePath, and pages without either", async () => {
		const owned = fake.addPage({
			title: "Owned",
			parentId: fake.rootId,
			properties: {
				[OWNER_KEY]: { v: 1, root: fake.rootId, source: "a.md", digest: "abc", version: 3 },
			},
		});
		const legacy = fake.addPage({
			title: "Legacy",
			parentId: fake.rootId,
			properties: { filePath: "old\\b.md", contentHash: "x" },
		});
		const human = fake.addPage({ title: "Human", parentId: owned, authorId: "a-person" });
		const folder = fake.addPage({ title: "Folder", parentId: legacy, type: "folder" });
		const remote = await client().readRemote(fake.rootId);
		const property = fake.pages.get(owned)?.properties[0];

		expect(remote).toMatchObject({ rootId: fake.rootId, accountId: ACCOUNT, webBase: BASE_URL });
		expect(remote.pages).toEqual([
			{
				id: owned,
				parentId: fake.rootId,
				title: "Owned",
				version: 1,
				authorId: ACCOUNT,
				editorId: ACCOUNT,
				owner: {
					source: "a.md",
					root: fake.rootId,
					digest: "abc",
					version: 3,
					property: { id: property?.id, version: 1 },
				},
			},
			{
				id: human,
				parentId: owned,
				title: "Human",
				version: 1,
				authorId: "a-person",
				editorId: "a-person",
				owner: null,
			},
			{
				id: legacy,
				parentId: fake.rootId,
				title: "Legacy",
				version: 1,
				authorId: ACCOUNT,
				editorId: ACCOUNT,
				owner: { source: "old/b.md", root: null, digest: null, version: null, property: null },
			},
		]);
		expect(remote.nodes).toEqual([
			{ id: owned, parentId: fake.rootId },
			{ id: human, parentId: owned },
			{ id: legacy, parentId: fake.rootId },
			{ id: folder, parentId: legacy },
		]);
	});

	it.each([
		["a source that is not a string", { source: 42 }],
		[
			"a source with a control character",
			{ v: 1, root: "1", source: "a\n::notice::x", digest: "d", version: 1 },
		],
	])("rejects an ownership property with %s", async (_case, value) => {
		const id = fake.addPage({
			title: "Odd",
			parentId: fake.rootId,
			properties: { [OWNER_KEY]: value },
		});
		await expect(client().readRemote(fake.rootId)).rejects.toThrow(
			`Page ${id} has an invalid ${OWNER_KEY} property`,
		);
	});

	it("follows a next link under a gateway base URL", async () => {
		const gateway = "https://api.atlassian.com/ex/confluence/cloud-1/wiki";
		const urls: string[] = [];
		const responses = [
			{ id: "1", spaceId: "9000", _links: { base: "https://example.atlassian.net/wiki" } },
			{ accountId: ACCOUNT },
			{ results: [], _links: { next: "/wiki/api/v2/pages/1/descendants?cursor=abc" } },
			{ results: [], _links: {} },
		];
		const recording = async (input: string | URL | Request) => {
			urls.push(String(input));
			return Response.json(responses[urls.length - 1]);
		};
		await client({ baseUrl: gateway, fetch: recording }).readRemote("1");
		expect(urls[3]).toBe(`${gateway}/api/v2/pages/1/descendants?cursor=abc`);
	});
});

describe("syncAttachments", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "attachments-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("uploads new and changed files, skips unchanged ones, and deletes only its own stale files", async () => {
		const id = fake.addPage({ title: "A", parentId: fake.rootId });
		await writeFile(join(dir, "logo.png"), "logo");
		await writeFile(join(dir, "chart.png"), "chart");
		const confluence = client();
		await confluence.syncAttachments(id, [
			{ name: "logo.png", path: join(dir, "logo.png"), sha256: "h-logo" },
			{ name: "old.png", path: join(dir, "logo.png"), sha256: "h-old" },
		]);
		fake.pages.get(id)?.attachments.push({
			id: "human",
			title: "notes.pdf",
			comment: "",
			bytes: new Uint8Array(),
			status: "current",
		});

		const result = await confluence.syncAttachments(id, [
			{ name: "logo.png", path: join(dir, "logo.png"), sha256: "h-logo" },
			{ name: "chart.png", path: join(dir, "chart.png"), sha256: "h-chart" },
		]);

		expect(result).toEqual({ uploaded: 1, deleted: 1 });
		const current = fake.pages
			.get(id)
			?.attachments.filter((a) => a.status === "current")
			.map((a) => [a.title, a.comment, new TextDecoder().decode(a.bytes)]);
		expect(current).toEqual([
			["logo.png", "sha256:h-logo", "logo"],
			["notes.pdf", "", ""],
			["chart.png", "sha256:h-chart", "chart"],
		]);
	});
});
