# Design

This page records the decisions that the code cannot show by itself. Usage is in the
[README](../README.md).

## Pipeline

```
readSource()  files on disk -> DesiredPage[]           src/source.ts, src/markdown.ts  (no network)
readRemote()  Confluence    -> RemotePage[]            src/confluence.ts               (reads only)
plan()        desired + remote -> Step[] and errors    src/plan.ts                     (pure)
apply()       Step[] -> writes                         src/apply.ts
```

A dry run stops after `plan()`. The real run executes the same `Step[]`, so the preview cannot
differ from the run.

## Ownership

A page belongs to the action when it has the content property `confluence-publish-action` with the
value `{"v": 1, "root": "<page id>", "source": "<path>", "digest": "<sha256>", "version": <n>}`.

- `root` is the root page of the configuration that wrote the property. When `root` names another
  page inside this tree, the page belongs to that configuration. This run never matches or deletes
  it, and it counts as content that this run does not own. When `root` names a page outside the
  tree, for example after the tree moved to a new root, the page still belongs to this run.
- `source` is the path relative to `source-path`, with `/` separators. A folder's source is its
  directory path. The source is the page's identity. A renamed file is a new page.
- `digest` is the SHA-256 of the rendered title, the parent source, the storage-format body and the
  attachment hashes. A change in the output changes the digest. A change that leaves the output the
  same does not, so no version salt exists.
- `version` is the page version after the action's last write. A different version on the next run,
  or a latest version that another account wrote, means that someone edited the page in Confluence.
  The author of the latest version comes with the bulk read, so this check costs no request. It also
  catches an edit that lands between the action's update and its version read.

A page with only the `filePath` property from `confluence-markdown-sync-action` also counts as owned.
The first run adopts it and writes the new property.

## Order of writes

For each page, `apply()` writes in this order:

1. The page body (create or update).
2. For a create only: a provisional ownership property, with the digest `pending`, which matches no
   page.
3. The attachments.
4. A fresh read of the page version. An attachment upload may add a page version.
5. The ownership property, with the real digest.

The final property is the durable record that the page is current, so it comes last. When a run
stops before step 5, the page has the `pending` digest or an old one, and the next plan updates it.
Because of step 2, this holds even when the file's title or folder changes before the next run. Only
a stop between steps 1 and 2 leaves a page without a property. The next plan adopts such an orphan:
a page with no property, under the planned parent, with the planned title, created by the same
account.

Across pages, the steps run in this order. Each group frees titles or creates parents that a later
group needs.

1. Deletes, children first.
2. Updates and adopts whose parent exists. A rename runs after the rename that frees its title.
3. Creates, parents first.
4. Updates whose new parent was created in group 3.

Every title that a step gives must be free when the step runs. A title is free when no page has it,
or when the page that has it was deleted or renamed by an earlier step. The plan checks this for
creates and renames, against the pages in the tree (ignoring case) and against the rest of the
space. A title that is not free, including two pages that swap titles, is a plan error, so the run
stops before any write.

## Retries

| Request | Retried on |
| --- | --- |
| `GET`, `DELETE` | network error, timeout, 5xx, 429 |
| `POST`, `PUT` | 429 only |

- Confluence rejects a 429 before it processes the request, so any method can repeat it.
- A `POST` or `PUT` without a response has an unknown outcome, so the client does not repeat it.
  For a create, `apply()` looks the title up in the space and continues with the page it finds.
- Up to 4 attempts. The delay is exponential backoff with full jitter: base 500 ms, cap 10 s.
  `Retry-After` is honored up to 60 s. Each request has a 30 s timeout.
- A `DELETE` that returns 404 counts as done.

## Confluence API surface

| Operation | Endpoint |
| --- | --- |
| Root page, space ID, site URL | `GET /api/v2/pages/{id}` |
| Current account | `GET /rest/api/user/current` (v1; no v2 equivalent) |
| Subtree | `GET /api/v2/pages/{id}/descendants?depth=10&limit=250`, queried again below depth 10 |
| Versions and authors | `GET /api/v2/pages?id=…` (250 IDs a call) |
| Ownership | `GET /api/v2/pages/{id}/properties`, `POST …/properties`, `PUT …/properties/{property-id}` |
| Title check | `GET /api/v2/pages?space-id=…&title=…` |
| Create, update, delete | `POST /api/v2/pages`, `PUT /api/v2/pages/{id}`, `DELETE /api/v2/pages/{id}` (trash) |
| Attachments | list `GET /api/v2/pages/{id}/attachments`; upload `PUT /rest/api/content/{id}/child/attachment` (v1; no v2 equivalent); delete `DELETE /api/v2/attachments/{id}` |

An uploaded attachment carries `sha256:<hex>` in its comment. The action uploads a file only when
the hash differs. It deletes only attachments that carry such a comment, never attachments that
people added.

### Read cost

A run with P pages under the root, in a tree up to 10 levels deep, makes at most
2·⌈P/250⌉ + P + 2 reads before its first write. Each new page adds one title check, and each page at
depth 10 adds one more descendants query. The P term is one property read per page, with 5 in
flight. No documented endpoint returns a named
property for many pages at once. When a real workload shows that this is too slow, the next step is
to carry the digest in the version message, which `GET /api/v2/pages?id=…` returns in bulk.

## Deletes

The action deletes an owned page only when this account created it, and only when every item under
it is deleted too. An item can be a page, a folder, a whiteboard, a database or an embed.

- Confluence does not document what happens to the children of a deleted page, so the action never
  relies on it.
- Anyone who can edit a page can add an ownership property to it, so the property alone is not
  enough to delete. The creator of a page cannot be changed.

## Open questions

The fake Confluence in `test/fake-confluence.ts` encodes the documented behavior. These points are
not documented for Cloud and need `npm run test:live` against a real site:

- Whether Cloud keeps `ac:link` with `ri:page` and `ac:anchor`, `ri:url` images and
  `<a href="#Heading-Text">` heading links as written.
- Whether pages created through REST v2 open in the current editor.
- Whether a page in the trash still holds its title. If it does, a file that moves to another
  folder and keeps its H1 fails at create.
- Whether the `title` filter of `GET /api/v2/pages` ignores case. Confluence titles are unique
  ignoring case. If the filter does not ignore case, a page elsewhere in the space whose title
  differs only in case is not found by the plan, and the create fails during the run.
- Whether Confluence gives duplicate headings on one page different anchors. The action maps every
  duplicate to the anchor of the first one.
- Whether replacing or deleting an attachment in Confluence adds a page version. If it does not, the
  action does not notice such an edit until the file changes.
- Whether a page copied in Confluence keeps its content properties. If it does, the copy and the
  original both claim the same source, and the plan stops until one of them is in the trash.

Pages below a folder or another non-page item at depth 10 are not read. The descendants endpoint for
pages cannot list them.
