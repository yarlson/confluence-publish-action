import GithubSlugger from "github-slugger";
import type {
	Blockquote,
	Definition,
	FootnoteDefinition,
	List,
	ListItem,
	Nodes,
	PhrasingContent,
	Root,
	RootContent,
	Table,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";

export interface Document {
	/** The body, without the title heading. */
	root: Root;
	title: string | null;
	/** GitHub heading slug to Confluence heading anchor. */
	anchors: Map<string, string>;
}

export type LinkTarget =
	| { kind: "page"; title: string; anchor?: string }
	| { kind: "url"; href: string }
	| { kind: "text" };

export type ImageTarget =
	| { kind: "attachment"; name: string; width?: number }
	| { kind: "url"; src: string }
	| { kind: "none" };

export interface Resolver {
	/** Called for every link whose URL does not start with "#". */
	link(url: string, line: number): LinkTarget;
	image(url: string, line: number): ImageTarget;
	warn(message: string, line: number): void;
}

export function parse(markdown: string): Document {
	const tree = fromMarkdown(markdown, {
		extensions: [gfm(), frontmatter()],
		mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown()],
	});
	const heading = tree.children.find((node) => node.type === "heading" && node.depth === 1);
	const root: Root = { ...tree, children: tree.children.filter((node) => node !== heading) };

	// GitHub numbers duplicate slugs in document order, the title heading included.
	const slugger = new GithubSlugger();
	const anchors = new Map<string, string>();
	walk(tree, (node) => {
		if (node.type !== "heading") return;
		const text = plainText(node);
		const slug = slugger.slug(text);
		if (node !== heading) anchors.set(slug, confluenceAnchor(text));
	});

	const title = heading ? stripInvalidXml(plainText(heading)).replace(/\s+/g, " ").trim() : "";
	return { root, title: title || null, anchors };
}

/** Confluence's heading anchor: case kept, whitespace runs become "-", RFC 3986 encoding. */
function confluenceAnchor(text: string): string {
	return encodeURIComponent(text.trim().replace(/\s+/g, "-")).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

interface Context {
	doc: Document;
	resolver: Resolver;
	definitions: Map<string, Definition>;
	footnoteDefinitions: Map<string, FootnoteDefinition>;
	/** Footnote identifiers in the order of their first reference. */
	footnoteOrder: string[];
	inListItem: boolean;
}

/** Renders the document body as Confluence storage format. */
export function render(doc: Document, resolver: Resolver): string {
	const ctx: Context = {
		doc,
		resolver,
		definitions: new Map(),
		footnoteDefinitions: new Map(),
		footnoteOrder: [],
		inListItem: false,
	};
	// CommonMark: the first definition of a label wins.
	walk(doc.root, (node) => {
		if (node.type === "definition" && !ctx.definitions.has(node.identifier)) {
			ctx.definitions.set(node.identifier, node);
		}
		if (node.type === "footnoteDefinition" && !ctx.footnoteDefinitions.has(node.identifier)) {
			ctx.footnoteDefinitions.set(node.identifier, node);
		}
	});

	const body = nodes(doc.root.children, ctx);
	const footnotes: string[] = [];
	const inFootnote: Context = { ...ctx, inListItem: true };
	// Footnote definitions can reference further footnotes, which grows the order while we render.
	for (let i = 0; i < ctx.footnoteOrder.length; i++) {
		const definition = ctx.footnoteDefinitions.get(ctx.footnoteOrder[i] as string);
		footnotes.push(`<li>${definition ? nodes(definition.children, inFootnote) : ""}</li>`);
	}
	return footnotes.length > 0 ? `${body}<hr /><ol>${footnotes.join("")}</ol>` : body;
}

function nodes(children: RootContent[], ctx: Context): string {
	return children.map((child) => node(child, ctx)).join("");
}

function node(n: RootContent, ctx: Context): string {
	switch (n.type) {
		case "paragraph":
			return `<p>${nodes(n.children, ctx)}</p>`;
		case "heading":
			return `<h${n.depth}>${nodes(n.children, ctx)}</h${n.depth}>`;
		case "thematicBreak":
			return "<hr />";
		case "blockquote":
			return blockquote(n, ctx);
		case "list":
			return list(n, ctx);
		case "listItem":
			return `<li>${listItemBody(n, false, ctx)}</li>`;
		case "table":
			return table(n, ctx);
		case "tableRow":
			return `<tr>${nodes(n.children, ctx)}</tr>`;
		case "tableCell":
			return `<td>${nodes(n.children, ctx)}</td>`;
		case "code":
			return codeMacro(n.value, n.lang);
		case "html":
			ctx.resolver.warn(`Raw HTML is not published: ${n.value.slice(0, 60)}`, line(n));
			return "";
		case "definition":
		case "footnoteDefinition":
		case "yaml":
			return "";
		case "text":
			return escapeText(n.value);
		case "emphasis":
			return `<em>${nodes(n.children, ctx)}</em>`;
		case "strong":
			return `<strong>${nodes(n.children, ctx)}</strong>`;
		case "delete":
			return `<span style="text-decoration: line-through;">${nodes(n.children, ctx)}</span>`;
		case "inlineCode":
			return `<code>${escapeText(n.value)}</code>`;
		case "break":
			return "<br />";
		case "link":
			return link(n.url, n.children, line(n), ctx);
		case "linkReference": {
			const definition = ctx.definitions.get(n.identifier);
			return definition ? link(definition.url, n.children, line(n), ctx) : nodes(n.children, ctx);
		}
		case "image":
			return image(n.url, n.alt, line(n), ctx);
		case "imageReference": {
			const definition = ctx.definitions.get(n.identifier);
			return definition ? image(definition.url, n.alt, line(n), ctx) : escapeText(n.alt ?? "");
		}
		case "footnoteReference": {
			let index = ctx.footnoteOrder.indexOf(n.identifier);
			if (index === -1) index = ctx.footnoteOrder.push(n.identifier) - 1;
			return `<sup>[${index + 1}]</sup>`;
		}
		default:
			return unreachable(n);
	}
}

const alerts = {
	NOTE: { panel: "info", title: "📘 Note" },
	TIP: { panel: "tip", title: "💡 Tip" },
	IMPORTANT: { panel: "note", title: "ℹ️ Important" },
	WARNING: { panel: "warning", title: "⚠️ Warning" },
	CAUTION: { panel: "warning", title: "🛑 Caution" },
} as const;

const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

/** A GitHub alert becomes a panel macro, or an expand macro inside a list item, where panels do not nest. */
function blockquote(n: Blockquote, ctx: Context): string {
	const [first, ...rest] = n.children;
	const firstText = first?.type === "paragraph" ? first.children[0] : undefined;
	const match = firstText?.type === "text" ? alertMarker.exec(firstText.value) : null;
	if (!match || first?.type !== "paragraph" || firstText?.type !== "text") {
		return `<blockquote>${nodes(n.children, ctx)}</blockquote>`;
	}

	const remainder = firstText.value.slice(match[0].length);
	const firstChildren: PhrasingContent[] = remainder
		? [{ ...firstText, value: remainder }, ...first.children.slice(1)]
		: first.children.slice(1);
	const children: RootContent[] =
		firstChildren.length > 0 ? [{ ...first, children: firstChildren }, ...rest] : rest;
	const body = `<ac:rich-text-body>${nodes(children, ctx)}</ac:rich-text-body>`;

	const alert = alerts[match[1] as keyof typeof alerts];
	if (ctx.inListItem) {
		return `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${alert.title}</ac:parameter>${body}</ac:structured-macro>`;
	}
	return `<ac:structured-macro ac:name="${alert.panel}">${body}</ac:structured-macro>`;
}

function list(n: List, ctx: Context): string {
	const tight = !n.spread && n.children.every((item) => !item.spread);
	if (n.children.every((item) => typeof item.checked === "boolean")) {
		const tasks = n.children.map((item) => {
			const status = item.checked ? "complete" : "incomplete";
			return `<ac:task><ac:task-status>${status}</ac:task-status><ac:task-body>${listItemBody(item, tight, ctx)}</ac:task-body></ac:task>`;
		});
		return `<ac:task-list>${tasks.join("")}</ac:task-list>`;
	}

	const items = n.children.map((item) => {
		const box = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
		return `<li>${box}${listItemBody(item, tight, ctx)}</li>`;
	});
	if (!n.ordered) return `<ul>${items.join("")}</ul>`;
	const start = n.start != null && n.start !== 1 ? ` start="${n.start}"` : "";
	return `<ol${start}>${items.join("")}</ol>`;
}

/** In a tight list, paragraphs render without <p>, as GitHub renders them. */
function listItemBody(item: ListItem, tight: boolean, ctx: Context): string {
	const inner: Context = { ...ctx, inListItem: true };
	return item.children
		.map((child) =>
			tight && child.type === "paragraph" ? nodes(child.children, inner) : node(child, inner),
		)
		.join("");
}

function table(n: Table, ctx: Context): string {
	const rows = n.children.map((row, index) => {
		const tag = index === 0 ? "th" : "td";
		const cells = row.children.map((cell) => `<${tag}>${nodes(cell.children, ctx)}</${tag}>`);
		return `<tr>${cells.join("")}</tr>`;
	});
	return `<table><tbody>${rows.join("")}</tbody></table>`;
}

function codeMacro(value: string, language: string | null | undefined): string {
	const parameter = language
		? `<ac:parameter ac:name="language">${escapeText(language)}</ac:parameter>`
		: "";
	const cdata = stripInvalidXml(value).replaceAll("]]>", "]]]]><![CDATA[>");
	return `<ac:structured-macro ac:name="code">${parameter}<ac:plain-text-body><![CDATA[${cdata}]]></ac:plain-text-body></ac:structured-macro>`;
}

const safeScheme = /^(https?|mailto|tel):/i;
const anyScheme = /^[a-z][a-z0-9+.-]*:/i;

/** A percent-decoded fragment, as a browser shows it; the raw value when it does not decode. */
export function decodeFragment(fragment: string): string {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return fragment;
	}
}

function link(url: string, children: PhrasingContent[], at: number, ctx: Context): string {
	const text = nodes(children, ctx);
	if (url.startsWith("#")) {
		const fragment = decodeFragment(url.slice(1));
		return `<a href="#${escapeAttribute(ctx.doc.anchors.get(fragment) ?? fragment)}">${text}</a>`;
	}

	const target = ctx.resolver.link(url, at);
	switch (target.kind) {
		case "page": {
			const anchor = target.anchor ? ` ac:anchor="${escapeAttribute(target.anchor)}"` : "";
			return `<ac:link${anchor}><ri:page ri:content-title="${escapeAttribute(target.title)}" /><ac:link-body>${text}</ac:link-body></ac:link>`;
		}
		case "url": {
			// Browsers ignore leading and trailing controls and spaces, and tabs and newlines inside
			// a URL, so the scheme check must see the URL the way a browser will.
			const href = target.href
				// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
				.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
				.replace(/[\t\n\r]/g, "");
			if (anyScheme.test(href) && !safeScheme.test(href)) {
				ctx.resolver.warn(
					`Link with an unsupported scheme is published as text: ${href.slice(0, 60)}`,
					at,
				);
				return text;
			}
			return `<a href="${escapeAttribute(href)}">${text}</a>`;
		}
		case "text":
			return text;
		default:
			return unreachable(target);
	}
}

function image(url: string, alt: string | null | undefined, at: number, ctx: Context): string {
	const altAttribute = alt ? ` ac:alt="${escapeAttribute(alt)}"` : "";
	const target = ctx.resolver.image(url, at);
	switch (target.kind) {
		case "attachment": {
			const width = target.width ? ` ac:width="${target.width}"` : "";
			return `<ac:image${altAttribute}${width}><ri:attachment ri:filename="${escapeAttribute(target.name)}" /></ac:image>`;
		}
		case "url":
			if (!/^https?:/i.test(target.src)) return escapeText(alt ?? "");
			return `<ac:image${altAttribute}><ri:url ri:value="${escapeAttribute(target.src)}" /></ac:image>`;
		case "none":
			return escapeText(alt ?? "");
		default:
			return unreachable(target);
	}
}

function plainText(n: Nodes): string {
	if (n.type === "text" || n.type === "inlineCode") return n.value;
	return "children" in n ? n.children.map(plainText).join("") : "";
}

function walk(n: Nodes, visit: (node: Nodes) => void): void {
	visit(n);
	if ("children" in n) for (const child of n.children) walk(child, visit);
}

function line(n: Nodes): number {
	return n.position?.start.line ?? 0;
}

/** XML 1.0 forbids these control characters even when escaped. */
function stripInvalidXml(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

function escapeText(text: string): string {
	return stripInvalidXml(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
	return escapeText(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function unreachable(value: never): never {
	throw new Error(`unhandled Markdown node: ${JSON.stringify(value)}`);
}
