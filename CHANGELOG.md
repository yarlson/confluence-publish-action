# Changelog

## 0.1.1 (2026-10-24)

First release.

- Publishes a folder of GitHub Flavored Markdown as a Confluence Cloud page tree with REST API v2.
- Plans every write before the first one. `dry-run` prints the same plan that a real run executes.
- Identifies pages by an ownership property that records the root page, so trees of several
  configurations can nest. It deletes only pages that its account created, and never a page that
  still has content it does not own.
- Checks every new or changed title against the tree and the space before the first write.
- Makes no writes when nothing changed. A run that stops halfway is completed by the next run,
  without duplicates.
- Converts relative links to other published files into page links, and uploads local images as
  attachments only when they change.
- Moves deleted pages to the trash, children first, and refuses to run on a folder without Markdown.
- Matches `exclude-patterns` across dot folders, such as `node_modules/.pnpm`.
