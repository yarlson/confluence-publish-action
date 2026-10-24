# Publish Markdown to Confluence

A GitHub Action that publishes a folder of Markdown files as a page tree in Confluence Cloud.
Git is the source of truth. Confluence is a read-only mirror of one folder.

- **One-way and idempotent.** A run with no changes makes no writes. A run that stops halfway is
  finished by the next run, without duplicate pages.
- **Plan first.** `dry-run: true` prints exactly the steps that a real run takes.
- **It touches only its own pages.** Each published page carries an ownership property for its root
  page. The action deletes only pages that it created, and never deletes a page that still has
  content it does not own.

> [!NOTE]
> Version 0.x. The behavior in this README is tested against an in-memory Confluence, and the live
> test passed against a Confluence Cloud site on 2026-10-24. Some Confluence behavior is still
> unconfirmed (see [docs/design.md](docs/design.md#open-questions)).

## Usage

```yaml
name: Publish docs

on:
  push:
    branches: [main]
    paths: ["docs/**"]

# Two runs at the same time can race. Queue them instead.
concurrency:
  group: confluence-publish
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: yarlson/confluence-publish-action@v0
        with:
          confluence-url: https://example.atlassian.net/wiki
          root-page-id: "123456789"
          email: docs-bot@example.com
          api-token: ${{ secrets.CONFLUENCE_API_TOKEN }}
```

Create the API token at <https://id.atlassian.com/manage-profile/security/api-tokens> for the
account in `email`. That account needs permission to view, create and delete pages in the space.

To preview a change, run the same step with `dry-run: true`, for example in a pull request.

Use one configuration for each root page. Two workflows that publish to the same `root-page-id`
delete each other's pages. A workflow may publish to a page inside another workflow's tree.

Re-running an old workflow run publishes the files of that old commit. Publish only from the default
branch.

## Inputs

| name               | required | default                         | description                                                                     |
| ------------------ | -------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `confluence-url`   | yes      |                                 | Confluence Cloud base URL, ending in `/wiki`.                                   |
| `root-page-id`     | yes      |                                 | ID of the existing page that the published tree goes under. The action never changes this page. |
| `email`            | yes      |                                 | Email of the Atlassian account that owns the API token.                         |
| `api-token`        | yes      |                                 | Atlassian API token for that account. Store it as a secret.                     |
| `source-path`      | no       | `docs`                          | Folder of Markdown files, relative to the workspace.                            |
| `exclude-patterns` | no       | `**/node_modules/**,**/.git/**` | Glob patterns to skip, relative to `source-path`, separated by commas or newlines. |
| `dry-run`          | no       | `false`                         | When `true`, print the plan and change nothing.                                 |

For a scoped API token, set `confluence-url` to
`https://api.atlassian.com/ex/confluence/<cloud-id>/wiki`.

## Outputs

| name            | description                                       |
| --------------- | ------------------------------------------------- |
| `pages-created` | Number of pages created.                          |
| `pages-updated` | Number of pages updated, including adopted pages. |
| `pages-deleted` | Number of pages moved to the trash.               |
| `pages-skipped` | Number of pages left unchanged.                   |

In a dry run, the outputs hold the planned counts.

## How files become pages

- Each `.md` file becomes a page. Each folder that contains Markdown becomes a page that lists its
  child pages. The tree goes under `root-page-id` in the same shape as the folder.
- **Titles.** The title is the first top-level `# heading`, which is removed from the body.
  Without one, the title is the file name without `.md`. A folder title is its name in title case
  (`getting-started` becomes `Getting Started`, and `API` becomes `Api`, as in
  confluence-markdown-sync-action).
- **Unique titles.** Confluence requires unique titles in a space, and ignores case. When two
  pages in the tree have the same title, each gets the names of its parent folders as a prefix,
  until the titles are unique: `Api / Introduction` and `Guide / Introduction`. When a new or renamed
  page's title is already used elsewhere in the space, the run stops before any write.
- **Links.** A relative link to another published file, such as `[Setup](../guide/setup.md#install)`,
  becomes a Confluence page link with the heading anchor. A link that starts with `#` goes to a
  heading on the same page. A link to a file that is not published stays as it is, with a warning.
- **Images.** A local image with an image file extension (`.png`, `.jpg`, `.gif`, `.svg`, `.webp`
  and similar) is uploaded as an attachment, at most 760 px wide. It is uploaded again only when the
  file changes. An image URL (`https://…`) stays a URL. An image path that resolves outside the
  workspace stops the run. An image marked `#gh-dark-mode-only` is skipped, because GitHub shows it
  only in its dark theme.
- **Supported Markdown.** GitHub Flavored Markdown: headings, emphasis, strikethrough, lists, task
  lists, tables, code blocks (Confluence code macro), block quotes, footnotes, and
  [GitHub alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts)
  (`> [!NOTE]`, which become Confluence panels). YAML front matter is removed.

### Not supported

- Raw HTML. It is dropped, with a warning annotation on the file and line.
- Symbolic links to Markdown files or folders. They are skipped, with a warning.
- `:::` containers, Mermaid, math, and emoji shortcodes.
- Titles from front matter, and `README.md` or `index.md` as the folder page.
- Page order. Confluence orders new pages by when they were created.
- Table column alignment, and links back from footnotes.
- Two-way sync. An edit made in Confluence is overwritten on the next run, with a warning.
- Confluence Data Center and Server. The action uses the Cloud REST API v2.

## Safety

- **Ownership.** Every page that the action writes carries a content property named
  `confluence-publish-action`. The property holds the root page, the source path and a digest of the
  rendered page. The action matches pages by this property. The one exception is the recovery after
  an interrupted run, below. A page whose property names another root page inside this tree belongs
  to another configuration, and the action never changes or deletes it.
- **Deletes.** A page whose file is gone moves to the Confluence trash, where you can restore it.
  Child pages go first. The action keeps the page, and logs `keep`, when the page still has a child
  item that the action does not own (a page, folder or whiteboard), or when another account created
  the page.
- **Empty source.** When `source-path` holds no Markdown file, the run fails before any write. A
  wrong path or a missing checkout therefore cannot delete the tree.
- **Edits in Confluence.** The property records the page version after each write. When the version
  differs on the next run, or another account wrote the latest version, someone edited the page in
  Confluence. The action overwrites the edit and logs a warning.
- **Interrupted runs.** A new page gets a provisional ownership property at once, and the final
  property last, after the body and the attachments. When a run stops in between, the next run
  updates the page. When it stops before even the provisional property, the next run adopts the page,
  if this account created it under the planned parent with the planned title.

## Migrating from confluence-markdown-sync-action

The action adopts the pages that `confluence-markdown-sync-action` created, through its `filePath`
property. The page IDs, comments and links stay.

1. Change `uses:` to `yarlson/confluence-publish-action@v0`.
2. Add `email`. Confluence Cloud accepts API tokens only together with the account email.
3. Remove `space-key` (the root page decides the space) and `validate-only` (use `dry-run`).
4. Run once with `dry-run: true`. Expect `adopt` steps for the existing pages.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `failed with 401` | Check `email` and `api-token`. The token must belong to that account. |
| `failed with 403` | Give the account permission to view, create and delete pages in the space. |
| `GET /api/v2/pages/<id> failed with 404` | Check `root-page-id`, and that the account can view that page. |
| `failed with 409` | The page changed during the run, or the space requires approval to publish. Run the workflow again. |
| `Cannot give <file> the title "<title>": page <id> in the space already has it` | Another page in the space has the title. Rename that page, or change the H1 of the file. |
| `… takes a title from this page` | Two pages swap titles in one change, which Confluence does not allow. Rename one of the two files in a separate change. |
| `Pages have the same title` | Two files in the same folder give the same title. Change the H1 of one of them. |
| `keep … another account created it` | The page has an ownership property, but this account did not create it. Move it to the trash yourself if it is no longer needed. |

## Development

```sh
npm ci
npm run check   # Biome, TypeScript, Vitest
npm run build   # writes dist/index.js; commit it
```

`npm run test:live` publishes a fixture tree to a real Confluence Cloud site. It reads
`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` and `CONFLUENCE_SPACE_KEY` from
`.env.test` or the environment. The test creates one temporary page at the top level of that space,
outside the homepage tree, puts its pages under it, and moves only those pages to the trash
afterwards.

## License

[MIT](LICENSE)
