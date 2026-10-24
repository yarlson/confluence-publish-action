import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { imageSize } from "image-size";
import { minimatch } from "minimatch";
import {
	type Document,
	decodeFragment,
	type ImageTarget,
	type LinkTarget,
	parse,
	render,
} from "./markdown";

/** One page that the files on disk ask for. */
export interface DesiredPage {
	/** Path relative to source-path with "/" separators; a folder's source is its directory path. */
	source: string;
	parentSource: string | null;
	title: string;
	body: string;
	attachments: Attachment[];
	digest: string;
	/** Path relative to the workspace, for annotations. */
	file: string;
}

export interface Attachment {
	name: string;
	/** Absolute path after symlinks are resolved. */
	path: string;
	sha256: string;
}

export interface SourceOptions {
	workspace: string;
	sourcePath: string;
	exclude: string[];
	warn(message: string, file: string, line?: number): void;
}

const folderBody = '<ac:structured-macro ac:name="children" />';
const maxImageWidth = 760;
const maxTitleLength = 255;
const anyScheme = /^[a-z][a-z0-9+.-]*:/i;
const imageExtension = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;

interface Entry {
	source: string;
	parentSource: string | null;
	path: string;
	name: string;
	folder: boolean;
}

/** Reads the source tree into pages in tree order, parents before children. */
export async function readSource(options: SourceOptions): Promise<DesiredPage[]> {
	const workspace = await realpath(options.workspace);
	const requested = resolve(workspace, options.sourcePath);
	const root = await realpath(requested).catch(() => requested);
	if (!isInside(workspace, requested) || !isInside(workspace, root)) {
		throw new Error(`source-path "${options.sourcePath}" is outside the workspace`);
	}
	if (!(await stat(root).catch(() => null))?.isDirectory()) {
		throw new Error(`source-path "${options.sourcePath}" is not a directory`);
	}

	const entries = await scan(root, "", options.exclude, (path) =>
		options.warn("Symbolic links are not followed", toPosix(relative(workspace, path))),
	);
	const docs = new Map<string, Document>();
	for (const entry of entries) {
		if (!entry.folder) docs.set(entry.source, parse(await readFile(entry.path, "utf8")));
	}
	const titles = uniqueTitles(entries, docs);

	return entries.map((entry) => {
		const title = titles.get(entry.source) as string;
		const file = toPosix(relative(workspace, entry.path));
		const { body, attachments } = entry.folder
			? { body: folderBody, attachments: [] }
			: renderFile(entry, file);
		const digest = createHash("sha256")
			.update(
				JSON.stringify([
					title,
					entry.parentSource,
					body,
					attachments.map((a) => [a.name, a.sha256]),
				]),
			)
			.digest("hex");
		return {
			source: entry.source,
			parentSource: entry.parentSource,
			title,
			body,
			attachments,
			digest,
			file,
		};
	});

	function renderFile(entry: Entry, file: string): { body: string; attachments: Attachment[] } {
		const attachments: Attachment[] = [];
		const warn = (message: string, line: number) => options.warn(message, file, line);

		const link = (url: string, line: number): LinkTarget => {
			if (anyScheme.test(url) || url.startsWith("//")) return { kind: "url", href: url };
			const { path, fragment } = splitUrl(url);
			const target = path === "" ? entry.path : localPath(path, entry);
			const source = target && isInside(root, target) ? toPosix(relative(root, target)) : null;
			const targetTitle = source === null ? undefined : titles.get(source);
			if (source === null || targetTitle === undefined) {
				warn(`Link target is not published: ${url}`, line);
				return { kind: "url", href: url };
			}
			const anchor =
				fragment === undefined
					? undefined
					: docs.get(source)?.anchors.get(decodeFragment(fragment));
			return anchor
				? { kind: "page", title: targetTitle, anchor }
				: { kind: "page", title: targetTitle };
		};

		const image = (url: string, line: number): ImageTarget => {
			const { path, fragment } = splitUrl(url);
			// GitHub shows this variant only in its dark theme.
			if (fragment === "gh-dark-mode-only") return { kind: "skip" };
			if (/^https?:/i.test(url)) return { kind: "url", src: url };
			const target =
				anyScheme.test(url) || url.startsWith("//") || path === "" ? null : localPath(path, entry);
			if (!target) {
				warn(`Image is not published: ${url.slice(0, 60)}`, line);
				return { kind: "none" };
			}
			// Before any file system access: a UNC path on Windows would reach the network.
			if (!isInside(workspace, target)) {
				throw new Error(`Image ${url} in ${file} resolves outside the workspace`);
			}
			if (!imageExtension.test(target)) {
				warn(`Image is not published, because its file name has no image extension: ${url}`, line);
				return { kind: "none" };
			}
			let real: string;
			try {
				real = realpathSync(target);
			} catch {
				warn(`Image not found: ${url}`, line);
				return { kind: "none" };
			}
			if (!isInside(workspace, real)) {
				throw new Error(`Image ${url} in ${file} resolves outside the workspace`);
			}
			if (!statSync(real).isFile()) {
				warn(`Image not found: ${url}`, line);
				return { kind: "none" };
			}

			const bytes = readFileSync(real);
			const width = imageWidth(bytes);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const known = attachments.find((a) => a.sha256 === sha256);
			if (known) return { kind: "attachment", name: known.name, width };

			const name = attachments.some((a) => a.name === basename(target))
				? `${sha256.slice(0, 8)}-${basename(target)}`
				: basename(target);
			attachments.push({ name, path: real, sha256 });
			return { kind: "attachment", name, width };
		};

		const body = render(docs.get(entry.source) as Document, { link, image, warn });
		return { body, attachments };
	}

	/** Resolves a Markdown path the way GitHub does: "/" is the workspace root, otherwise the file's folder. */
	function localPath(path: string, from: Entry): string | null {
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return null;
		}
		return decoded.startsWith("/")
			? join(workspace, decoded)
			: resolve(dirname(from.path), decoded);
	}
}

async function scan(
	dir: string,
	prefix: string,
	exclude: string[],
	skipped: (path: string) => void,
): Promise<Entry[]> {
	const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	const entries: Entry[] = [];
	for (const child of children) {
		const source = prefix ? `${prefix}/${child.name}` : child.name;
		// A trailing "/" lets "drafts/**" match the folder itself, so excluded folders are not walked.
		const candidate = child.isDirectory() ? `${source}/` : source;
		if (exclude.some((pattern) => minimatch(candidate, pattern, { dot: true }))) continue;
		const entry = {
			source,
			parentSource: prefix || null,
			path: join(dir, child.name),
			name: child.name,
		};
		if (child.isDirectory()) {
			const inner = await scan(entry.path, source, exclude, skipped);
			if (inner.length > 0) entries.push({ ...entry, folder: true }, ...inner);
		} else if (child.isFile() && child.name.endsWith(".md")) {
			entries.push({ ...entry, folder: false });
		} else if (
			child.isSymbolicLink() &&
			(child.name.endsWith(".md") || statSync(entry.path, { throwIfNoEntry: false })?.isDirectory())
		) {
			skipped(entry.path);
		}
	}
	return entries;
}

/**
 * Confluence titles are unique per space, ignoring case. Every member of a collision gets the
 * shortest parent-folder prefix that makes it unique, so the result does not depend on order.
 */
function uniqueTitles(entries: Entry[], docs: Map<string, Document>): Map<string, string> {
	const pages: TitledPage[] = entries.map((entry) => ({
		source: entry.source,
		base: entry.folder
			? titleCase(entry.name)
			: (docs.get(entry.source)?.title ??
				(entry.name.slice(0, -".md".length).replace(/\s+/g, " ").trim() || entry.name)),
		folders: entry.source.split("/").slice(0, -1).map(titleCase),
		depth: 0,
	}));

	for (;;) {
		const groups = Map.groupBy(pages, (page) => titleOf(page).toLowerCase());
		const collisions = [...groups.values()].filter((group) => group.length > 1);
		if (collisions.length === 0) break;
		for (const group of collisions) {
			const movable = group.filter((page) => page.depth < page.folders.length);
			if (movable.length === 0) {
				throw new Error(
					`Pages have the same title "${titleOf(group[0] as TitledPage)}": ${group.map((page) => page.source).join(", ")}. Give one of them a different H1.`,
				);
			}
			for (const page of movable) page.depth++;
		}
	}

	const titles = new Map<string, string>();
	for (const page of pages) {
		const title = titleOf(page);
		if (title.length > maxTitleLength) {
			throw new Error(
				`Title of ${page.source} is ${title.length} characters; Confluence allows ${maxTitleLength}.`,
			);
		}
		titles.set(page.source, title);
	}
	return titles;
}

interface TitledPage {
	source: string;
	base: string;
	/** Titles of the parent folders, outermost first. */
	folders: string[];
	/** How many parent folders prefix the title. */
	depth: number;
}

function titleOf(page: TitledPage): string {
	if (page.depth === 0) return page.base;
	return `${page.folders.slice(page.folders.length - page.depth).join(" / ")} / ${page.base}`;
}

/** As confluence-markdown-sync-action did, so adopted folder pages keep their titles. */
function titleCase(name: string): string {
	const title = name
		.replace(/[-_]/g, " ")
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ")
		.trim();
	return title || name;
}

/** The path of a Markdown URL without its query and fragment, and the fragment. */
function splitUrl(url: string): { path: string; fragment?: string } {
	const hash = url.indexOf("#");
	const beforeHash = hash === -1 ? url : url.slice(0, hash);
	const query = beforeHash.indexOf("?");
	const path = query === -1 ? beforeHash : beforeHash.slice(0, query);
	return hash === -1 ? { path } : { path, fragment: url.slice(hash + 1) };
}

function imageWidth(bytes: Uint8Array): number | undefined {
	try {
		const { width } = imageSize(bytes);
		return width ? Math.min(width, maxImageWidth) : undefined;
	} catch {
		return undefined;
	}
}

function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}
