# Publish Markdown to Confluence

This GitHub Action publishes a folder of Markdown files as a page tree in Confluence Cloud. The
folder in Git is the source of truth. The page tree is a read-only copy of it.

Each run reads the files, reads the pages in Confluence, plans every change, and then makes the
changes. The design notes are in [docs/design.md](docs/design.md).

## What it promises

- **No surprises.** `dry-run: true` prints the exact steps that a real run takes.
- **No needless writes.** When no file changed, a run changes nothing in Confluence.
- **No duplicates.** When a run stops halfway, the next run finishes the work.
- **No damage to other pages.** The action changes only pages that it published. It deletes only
  pages that its own account created, and it moves them to the trash.

## Quick start

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>. The
   account needs permission to view, add and delete pages and attachments in the space.
2. Store the token as a repository secret named `CONFLUENCE_API_TOKEN`.
3. Pick the Confluence page that the tree goes under. Copy its ID from the page URL.
4. Add this workflow:

```yaml
name: Publish docs

on:
  push:
    branches: [main]
    paths: ["docs/**"]

# Two runs at the same time can race, so queue them.
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

      - uses: yarlson/confluence-publish-action@v0.1.1
        with:
          confluence-url: https://example.atlassian.net/wiki
          root-page-id: "123456789"
          email: docs-bot@example.com
          api-token: ${{ secrets.CONFLUENCE_API_TOKEN }}
```

Releases are immutable, so the `v0.1.1` tag always points to the same commit. If your
organization requires actions pinned to a full commit SHA, use the release commit instead:
`yarlson/confluence-publish-action@<sha> # v0.1.1`.

To see what a change will do, run the same step with `dry-run: true`, for example on pull requests.
Pull requests from forks get no secrets, so a dry run fails there.

## Inputs

| name               | required | default                         | description                                                                         |
| ------------------ | -------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `confluence-url`   | yes      |                                 | Confluence Cloud base URL, ending in `/wiki`.                                       |
| `root-page-id`     | yes      |                                 | ID of the existing page that the tree goes under. The action never changes this page. |
| `email`            | yes      |                                 | Email of the Atlassian account that owns the API token.                             |
| `api-token`        | yes      |                                 | API token of that account. Store it as a secret.                                    |
| `source-path`      | no       | `docs`                          | Folder of Markdown files, relative to the workspace.                                |
| `exclude-patterns` | no       | `**/node_modules/**,**/.git/**` | Glob patterns of paths to skip, relative to `source-path`. Separate them with commas or newlines. |
| `dry-run`          | no       | `false`                         | When `true`, print the plan and change nothing.                                     |

For a scoped API token, set `confluence-url` to
`https://api.atlassian.com/ex/confluence/<cloud-id>/wiki`.

## Outputs

| name            | description                                       |
| --------------- | ------------------------------------------------- |
| `pages-created` | Number of pages created.                          |
| `pages-updated` | Number of pages updated, including adopted pages. |
| `pages-deleted` | Number of pages moved to the trash.               |
| `pages-skipped` | Number of pages left unchanged.                   |

In a dry run, the outputs hold the planned counts. The job summary lists every step, with links to
the published pages.

## How files become pages

- **Tree.** Each `.md` file becomes a page. Each folder that contains Markdown becomes a page that
  lists its child pages. The tree has the same shape as the folder.
- **Titles.** A page takes its title from the first top-level `# heading`, and the heading is
  removed from the body. Without such a heading, the title is the file name without `.md`. A folder
  page takes the folder name in title case: `getting-started` becomes `Getting Started`, and `API`
  becomes `Api`.
- **Unique titles.** Confluence needs a unique title for each page in a space, and it ignores case.
  When two files give the same title, each page gets its parent folder names as a prefix, as in
  `Api / Introduction` and `Guide / Introduction`. When another page in the space already has a
  title that a run needs, the run stops before it changes anything.
- **Links.** A relative link to another published file, such as `[Setup](../guide/setup.md#install)`,
  becomes a Confluence page link to that heading. A link that starts with `#` goes to a heading on
  the same page. A link to a file that is not published stays as it is, with a warning.
- **Images.** A local image with an image file extension, such as `.png`, `.jpg`, `.gif`, `.svg`
  or `.webp`, becomes an attachment, at most 760 px wide. It is uploaded again only when the file
  changes. An image URL stays a URL. An image marked `#gh-dark-mode-only` is skipped, because GitHub
  shows it only in its dark theme. An image path outside the workspace stops the run.
- **Markdown.** The action supports GitHub Flavored Markdown: headings, emphasis, strikethrough,
  lists, task lists, tables, code blocks, block quotes and footnotes. Code blocks become code
  macros, and
  [GitHub alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts)
  such as `> [!NOTE]` become Confluence panels. YAML front matter is removed.

## What the action touches

- **Its own pages only.** Each page that the action writes gets a content property named
  `confluence-publish-action`. The property records the root page, the source file and a hash of
  the rendered page. The action finds its pages by this property. It uses titles in one case only:
  to recover a page after an interrupted run, as described below.
- **Deletes.** When a file is gone, its page moves to the Confluence trash, children first. The
  action keeps the page and logs `keep` in two cases: something that the action does not own is
  under the page, such as a page, folder or whiteboard; or another account created the page.
- **Empty source.** When `source-path` holds no Markdown file, the run stops before it changes
  anything. A wrong path or a missing checkout cannot delete the tree.
- **Edits in Confluence.** The action notices when someone edits a published page in Confluence.
  It overwrites the edit with the file and logs a warning.
- **Interrupted runs.** A new page gets its ownership property right after the create, so the next
  run finishes the page even if the file changed in between. When a run stops before even that, the
  next run takes over the page, but only if this account created it, under the expected parent,
  with the expected title.
- **Other configurations.** A workflow may publish to a page inside another workflow's tree. Each
  one keeps to its own pages.

## Limits

- Use one workflow for each root page. Two workflows that publish to the same `root-page-id` delete
  each other's pages.
- A re-run of an old workflow run publishes the files of that old commit. Publish from the default
  branch only.
- Edits made in Confluence do not flow back to Git. The next run overwrites them.
- Raw HTML is dropped, with a warning on the file and line.
- Symbolic links to Markdown files or folders are skipped, with a warning.
- Not supported: `:::` containers, Mermaid, math, emoji shortcodes, titles from front matter,
  `README.md` or `index.md` as the folder page, table column alignment, and links back from
  footnotes.
- Confluence orders new pages by the time it created them. The action does not set an order.
- Confluence Data Center and Server do not work, because the action uses the Confluence Cloud REST
  API v2.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `failed with 401` | The token or the email is wrong. The token must belong to the account in `email`. |
| `failed with 403` | The account cannot view, add or delete pages or attachments in the space. Grant those permissions. |
| `GET /api/v2/pages/<id> failed with 404` | `root-page-id` is wrong, or the account cannot view that page. |
| `failed with 409` | The page changed during the run, or the space needs approval to publish. Run the workflow again. |
| `Cannot give <file> the title "<title>": page <id> in the space already has it` | Another page in the space has that title. Rename that page, or change the H1 of the file. |
| `… takes a title from this page` | Two pages swap titles in one change, which Confluence does not allow. Rename one of the files in a separate change. |
| `Pages have the same title` | Two files in one folder give the same title. Change the H1 of one of them. |
| `keep … another account created it` | The page has the ownership property, but another account created it. Move it to the trash yourself if you no longer need it. |

## Development

```sh
npm ci
npm run check   # Biome, TypeScript and the tests
npm run build   # writes dist/index.js, which must be committed
```

Dependabot opens weekly update pull requests for npm packages and workflow actions, for versions
at least 7 days old. An update of a runtime dependency changes `dist/index.js`, so CI fails on it
until you run `npm run build` on its branch and commit the result.

`npm run test:live` runs the action against a real Confluence Cloud site. It reads
`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` and `CONFLUENCE_SPACE_KEY` from
`.env.test` or the environment. It creates one temporary page at the top level of that space,
outside the homepage tree, and puts its test pages under it. At the end, it moves only those pages
to the trash.

### Releasing

The repository uses immutable releases, so the tag of a published version never moves. To release
version `X.Y.Z`:

1. Set `version` in `package.json` and the date of its `CHANGELOG.md` entry, and merge to `main`.
2. Tag the merge commit, and push the tag:
   `git tag -a vX.Y.Z -m vX.Y.Z <commit> && git push origin vX.Y.Z`.
3. Publish the release, with the CHANGELOG entry as notes:
   `gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <notes>`.
4. From 1.0.0 on, also move the major tag, which has no release of its own:
   `git tag -f -a vX -m vX vX.Y.Z^{} && git push -f origin vX`.

A 0.x release gets no major tag, because a 0.x minor version may break compatibility.

## License

[MIT](LICENSE)
