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
value `{"v": 1, "source": "<path>", "digest": "<sha256>", "version": <n>}`.

- `source` is the path relative to `source-path`, with `/` separators. A folder's source is its
  directory path. The source is the page's identity. A renamed file is a new page.
- `digest` is the SHA-256 of the rendered title, the parent source, the storage-format body and the
  attachment hashes. A change in the output changes the digest. A change that leaves the output the
  same does not, so no version salt exists.
- `version` is the page version after the action's last write. A different version on the next run
  means that someone edited the page in Confluence.

A page with only the `filePath` property from `confluence-markdown-sync-action` also counts as owned.
The first run adopts it and writes the new property.

## Order of writes

For each page, `apply()` writes in this order:

1. The page body (create or update).
2. The attachments.
3. A fresh read of the page version. An attachment upload may add a page version.
4. The ownership property.

The property is the durable record that the page is current, so it comes last. When a run stops
before step 4, the page has an old digest or no property. The next plan then updates the page, or
adopts it as an orphan. An orphan is a page with no property, under the planned parent, with the
planned title, created by the same account.

Across pages, the steps run in this order. Each group frees titles or creates parents that a later
group needs.

1. Deletes, children first.
2. Updates and adopts whose parent exists.
3. Creates, parents first.
4. Updates whose new parent was created in group 3.

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

The action deletes an owned page only when all of the page's children are deleted too. Confluence
does not document what happens to the children of a deleted page, so the action never relies on it.

## Open questions

The fake Confluence in `test/fake-confluence.ts` encodes the documented behavior. These points are
not documented for Cloud and need `npm run test:live` against a real site:

- Whether Cloud keeps `ac:link` with `ri:page` and `ac:anchor`, `ri:url` images and
  `<a href="#Heading-Text">` heading links as written.
- Whether pages created through REST v2 open in the current editor.
- Whether a page in the trash still holds its title. If it does, a file that moves to another
  folder and keeps its H1 fails at create.
