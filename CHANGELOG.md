# Changelog

## 0.1.0 (unreleased)

First release. It replaces `confluence-markdown-sync-action` and adopts the pages that action
created.

- Publishes a folder of GitHub Flavored Markdown as a Confluence Cloud page tree with REST API v2.
- Plans every write before the first one. `dry-run` prints the same plan that a real run executes.
- Identifies pages only by an ownership property. It never changes or deletes other pages.
- Makes no writes when nothing changed. A run that stops halfway is completed by the next run,
  without duplicates.
- Converts relative links to other published files into page links, and uploads local images as
  attachments only when they change.
- Moves deleted pages to the trash, children first, and refuses to run on a folder without Markdown.
- Requires `email`. Removes the `space-key` and `validate-only` inputs.
