import { describe, expect, it } from "vitest";
import { type ImageTarget, type LinkTarget, parse, type Resolver, render } from "./markdown";

const links: Record<string, LinkTarget> = {
	"../guide/setup.md#install": { kind: "page", title: "Setup & Run", anchor: "Install-It" },
	"notes.txt": { kind: "text" },
};
const images: Record<string, ImageTarget> = {
	"img/logo.png": { kind: "attachment", name: "logo.png", width: 640 },
	"missing.png": { kind: "none" },
};

function convert(markdown: string) {
	const warnings: Array<[string, number]> = [];
	const resolver: Resolver = {
		link: (url) => links[url] ?? { kind: "url", href: url },
		image: (url) => images[url] ?? { kind: "url", src: url },
		warn: (message, line) => warnings.push([message, line]),
	};
	const doc = parse(markdown);
	return { title: doc.title, body: render(doc, resolver), warnings };
}

describe("parse", () => {
	it("takes the first top-level H1 as the title and removes it from the body", () => {
		expect(convert("# Title\n\nIntro\n\n## Sub *x*")).toMatchObject({
			title: "Title",
			body: "<p>Intro</p><h2>Sub <em>x</em></h2>",
		});
	});

	it("ignores a # line inside a fenced code block when it looks for the title", () => {
		expect(convert("Intro\n\n```bash\n# install deps\n```\n\n# Real")).toEqual({
			title: "Real",
			body:
				"<p>Intro</p>" +
				'<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter>' +
				"<ac:plain-text-body><![CDATA[# install deps]]></ac:plain-text-body></ac:structured-macro>",
			warnings: [],
		});
	});

	it("returns a null title when there is no H1", () => {
		expect(convert("## Only a subheading").title).toBeNull();
	});

	it("collapses whitespace in the title and treats an empty H1 as no title", () => {
		expect(convert("Line one\nline two\n===").title).toBe("Line one line two");
		expect(convert("# ![logo](img/logo.png)").title).toBeNull();
		expect(convert("#\n\nBody").title).toBeNull();
	});

	it("drops YAML front matter", () => {
		expect(convert("---\ntitle: Hello\n---\n\nBody")).toEqual({
			title: null,
			body: "<p>Body</p>",
			warnings: [],
		});
	});
});

describe("render", () => {
	it("renders inline formatting and escapes text", () => {
		expect(convert("a *b* **c** ~~d~~ `e<f>`  \ng & h").body).toBe(
			"<p>a <em>b</em> <strong>c</strong> " +
				'<span style="text-decoration: line-through;">d</span> <code>e&lt;f&gt;</code><br />g &amp; h</p>',
		);
	});

	it("keeps text that contains colons", () => {
		expect(convert("Note:this and 16:9").body).toBe("<p>Note:this and 16:9</p>");
	});

	it("renders a thematic break", () => {
		expect(convert("a\n\n---\n\nb").body).toBe("<p>a</p><hr /><p>b</p>");
	});

	it("splits ]]> so that the CDATA section stays valid", () => {
		expect(convert("```js\nconst s = 'a]]>b';\n```").body).toBe(
			'<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
				"<ac:plain-text-body><![CDATA[const s = 'a]]]]><![CDATA[>b';]]></ac:plain-text-body></ac:structured-macro>",
		);
	});

	it("renders a code block without a language parameter when none is given", () => {
		expect(convert("```\nx\n```").body).toBe(
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
		);
	});

	it("renders a plain blockquote", () => {
		expect(convert("> quote").body).toBe("<blockquote><p>quote</p></blockquote>");
	});

	it("renders a top-level GitHub alert as a panel macro", () => {
		expect(convert("> [!WARNING]\n> Be careful").body).toBe(
			'<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Be careful</p></ac:rich-text-body></ac:structured-macro>',
		);
	});

	it("renders an alert inside a list item as an expand macro", () => {
		expect(convert("- item\n  > [!NOTE]\n  > Inside").body).toBe(
			"<ul><li>item" +
				'<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">📘 Note</ac:parameter>' +
				"<ac:rich-text-body><p>Inside</p></ac:rich-text-body></ac:structured-macro>" +
				"</li></ul>",
		);
	});

	it("renders a list where every item has a checkbox as a task list", () => {
		expect(convert("- [x] done\n- [ ] todo").body).toBe(
			"<ac:task-list>" +
				"<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
				"<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task>" +
				"</ac:task-list>",
		);
	});

	it("renders a list with only some checkboxes as a plain list", () => {
		expect(convert("- [x] done\n- plain").body).toBe("<ul><li>☑ done</li><li>plain</li></ul>");
	});

	it("keeps the start number of an ordered list", () => {
		expect(convert("3. a\n4. b").body).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
		expect(convert("1. a").body).toBe("<ol><li>a</li></ol>");
	});

	it("wraps the paragraphs of a loose list item", () => {
		expect(convert("- a\n\n  b").body).toBe("<ul><li><p>a</p><p>b</p></li></ul>");
	});

	it("renders a table with a header row", () => {
		expect(convert("| A | B |\n|---|---|\n| 1 | 2 |").body).toBe(
			"<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
	});

	it("renders a link to another published page with its anchor", () => {
		expect(convert("[setup](../guide/setup.md#install)").body).toBe(
			'<p><ac:link ac:anchor="Install-It"><ri:page ri:content-title="Setup &amp; Run" />' +
				"<ac:link-body>setup</ac:link-body></ac:link></p>",
		);
	});

	it("renders an external link and escapes its URL", () => {
		expect(convert("[site](https://example.com/?a=1&b=2)").body).toBe(
			'<p><a href="https://example.com/?a=1&amp;b=2">site</a></p>',
		);
	});

	it("renders only the text of a link that the resolver turns into text", () => {
		expect(convert("[notes](notes.txt)").body).toBe("<p>notes</p>");
	});

	it("renders only the text of a javascript: link", () => {
		expect(convert("[x](javascript:alert(1))").body).toBe("<p>x</p>");
	});

	it("maps same-page GitHub anchors to Confluence heading anchors", () => {
		expect(convert("## API Reference\n\nSee [ref](#api-reference) and [gone](#missing)").body).toBe(
			'<h2>API Reference</h2><p>See <a href="#API-Reference">ref</a> and <a href="#missing">gone</a></p>',
		);
	});

	it("resolves reference-style links through their definitions", () => {
		expect(convert("[site][s]\n\n[s]: https://example.com").body).toBe(
			'<p><a href="https://example.com">site</a></p>',
		);
	});

	it("resolves reference-style images through their definitions", () => {
		expect(convert("![Logo][l]\n\n[l]: img/logo.png").body).toBe(
			'<p><ac:image ac:alt="Logo" ac:width="640"><ri:attachment ri:filename="logo.png" /></ac:image></p>',
		);
	});

	it("renders attachment, URL and missing images", () => {
		expect(
			convert("![Logo](img/logo.png) ![ext](https://cdn.example.com/a.png) ![gone](missing.png)")
				.body,
		).toBe(
			'<p><ac:image ac:alt="Logo" ac:width="640"><ri:attachment ri:filename="logo.png" /></ac:image> ' +
				'<ac:image ac:alt="ext"><ri:url ri:value="https://cdn.example.com/a.png" /></ac:image> gone</p>',
		);
	});

	it("numbers footnotes in reference order and lists them at the end", () => {
		expect(convert("Text[^1] more[^n].\n\n[^n]: Second.\n[^1]: First.").body).toBe(
			"<p>Text<sup>[1]</sup> more<sup>[2]</sup>.</p><hr /><ol><li><p>First.</p></li><li><p>Second.</p></li></ol>",
		);
	});

	it("drops raw HTML and warns with its line", () => {
		expect(convert("Line<br>break\n\n<div>x</div>")).toEqual({
			title: null,
			body: "<p>Linebreak</p>",
			warnings: [
				["Raw HTML is not published: <br>", 1],
				["Raw HTML is not published: <div>x</div>", 3],
			],
		});
	});

	it("keeps the paragraphs of a loose task item apart", () => {
		expect(convert("- [ ] a\n\n  more\n- [x] b").body).toBe(
			"<ac:task-list>" +
				"<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body><p>a</p><p>more</p></ac:task-body></ac:task>" +
				"<ac:task><ac:task-status>complete</ac:task-status><ac:task-body><p>b</p></ac:task-body></ac:task>" +
				"</ac:task-list>",
		);
	});

	it("removes U+FFFE and U+FFFF, which XML does not allow", () => {
		expect(convert("a\uFFFEb\uFFFFc").body).toBe("<p>abc</p>");
	});

	it("uses the first of two definitions with the same label, as CommonMark does", () => {
		expect(convert("[a][x]\n\n[x]: https://first.example\n[x]: https://second.example").body).toBe(
			'<p><a href="https://first.example">a</a></p>',
		);
	});

	it("renders an alert inside a footnote as an expand macro", () => {
		expect(convert("x[^1]\n\n[^1]: > [!NOTE]\n    > y").body).toBe(
			"<p>x<sup>[1]</sup></p><hr /><ol><li>" +
				'<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">📘 Note</ac:parameter>' +
				"<ac:rich-text-body><p>y</p></ac:rich-text-body></ac:structured-macro></li></ol>",
		);
	});

	it("maps a percent-encoded same-page anchor", () => {
		expect(convert("## Über\n\n[u](#%C3%BCber)").body).toBe(
			'<h2>Über</h2><p><a href="#%C3%9Cber">u</a></p>',
		);
	});

	it("numbers duplicate slugs in document order, the title included", () => {
		expect(convert("## Setup\n\n# Setup\n\n## Setup\n\n[a](#setup) [b](#setup-2)").body).toBe(
			'<h2>Setup</h2><h2>Setup</h2><p><a href="#Setup">a</a> <a href="#Setup">b</a></p>',
		);
	});

	it.each([
		["< javascript:alert(1)>", "leading space"],
		["<\u0001javascript:alert(1)>", "leading control character"],
		["<java\tscript:alert(1)>", "tab inside"],
	])("renders only the text of a javascript: link hidden by a %s", (url, _case) => {
		expect(convert(`[x](${url})`).body).toBe("<p>x</p>");
	});

	it("keeps tel: links and warns about other schemes", () => {
		expect(convert("[call](tel:+123) [get](ftp://host/file)")).toEqual({
			title: null,
			body: '<p><a href="tel:+123">call</a> get</p>',
			warnings: [["Link with an unsupported scheme is published as text: ftp://host/file", 1]],
		});
	});

	it("does not change the document, so a second render gives the same output", () => {
		const doc = parse("> [!TIP]\n> Twice");
		const resolver: Resolver = {
			link: (url) => ({ kind: "url", href: url }),
			image: (url) => ({ kind: "url", src: url }),
			warn: () => {},
		};
		expect(render(doc, resolver)).toBe(render(doc, resolver));
	});
});
