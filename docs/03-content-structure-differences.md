# 03 - Content structure differences (empirical)

Source projects: `kptdobe/sample-content-da` (R2 `aem-content`) and `kptdobe/sample-content-hlx6` (S3 `helix-source-bus`).

## Method
1. List both prefixes at the storage level. Capture key, size, ETag, content-type, content-encoding, all user metadata and LastModified.
2. Download everything into `analysis/{da,hlx6}/` (git-ignored). Gunzip hlx6 bodies.
3. Normalize volatile values: UUID, ULID, epoch/ISO timestamps, ETags and emails become placeholders.
4. Map keys using the rules in [02](02-storage-model.md), then diff:
   - key sets: unmatched on either side
   - bodies: byte-equal, or equal after HTML/JSON normalization
   - metadata key sets per object type
   - versions per document: count, shape and metadata keys (not values and not order)
5. Generate the findings table below from the tool output, then review it by hand.

## Checks derived from 02 (each one confirmed or refuted)
- [ ] Folder markers: `x.props` (da) vs `x/.props` (hlx6)
- [ ] Text/source bodies' encoding and `uncompressed-length`; confirm binary media is stored uncompressed for migration
- [ ] HTML bodies are equal (are there wrapper or attribute differences?)
- [ ] Image URLs in HTML: `content.da.live/...` vs `./media_...` (+ media bus objects)
- [ ] Sheets: JSON shape identical (single, multi-sheet, `:private`)
- [ ] Versions: number of da `.da-versions/{id}/*.html` vs hlx6 `.versions/{id}/*`
- [ ] Audit lines in da with no hlx6 counterpart
- [ ] Deleted docs: da hard delete vs hlx6 `.trash/` + version
- [ ] Names with uppercase, space, `_`, unicode: resulting keys on each side

## Edge cases the samples must contain
- [ ] nested folders; names with spaces, unicode, `_` and uppercase letters
- [ ] an empty folder
- [ ] a document with several versions, including named versions and a restored one
- [ ] a sheet with multiple tabs, and a sheet with a `:private` tab
- [ ] an image pasted in a doc, a PDF, an SVG, an MP4 and a large image (> 5 MB) to exercise the media-upload ingestion limit
- [ ] an unsupported extension (e.g. `.txt`, `.xml`)
- [ ] a deleted doc and a deleted folder

## Tooling
```bash
node bin/dump.js -b da   kptdobe/sample-content-da     # -> analysis/da/...
node bin/dump.js -b hlx6 kptdobe/sample-content-hlx6   # -> analysis/hlx6/...
node bin/compare.js -o analysis/report.json analysis/da/kptdobe/sample-content-da analysis/hlx6/kptdobe/sample-content-hlx6
node bin/preflight.js -v --dump analysis/da/kptdobe/sample-content-da
```

## Findings (run of 2026-10-01)

Object counts:

| kind | da | hlx6 |
|---|---|---|
| doc | 4 | 4 |
| sheet | 1 | 1 |
| media | 3 | 3 |
| folder | 3 | 3 |
| version | 8 | 10 |
| audit | 6 | 0 |
| trash | 1 | 1 |

The sample sets differ only by user actions: `frescopa-logo-1.svg` vs `frescopa-logo.svg`, and the different delete histories.

| # | Dimension | da | hlx6 | Transformation | Lossy? |
|---|---|---|---|---|---|
| 1 | Key / path layout | `{org}/{site}/{path}` | `{target-org}/{target-site}/{path}` | ordinary source paths reused verbatim; no filename renaming | no |
| 2 | Documents (.html) | raw, `text/html`; e.g. `<main><div><p>…</p></div></main>` on one line | **gzip**; **re-serialized** by hlx6 (pretty-printed, so the uncompressed size differs: 110 → 114 bytes) | Bodies are equal after whitespace normalization. Write as-is (hlx6 accepts it) or reformat | no |
| 2b | Images in HTML | External URLs kept (e.g. `raw.githubusercontent.com/...`) | **Interned** into the media bus and rewritten to `https://main--{site}--{org}.aem.page/media_{hash}...` | Intern every non-allowed image URL into `helix-media-bus`, then rewrite the `src`/`srcset` | no (needs fetch) |
| 3 | Sheets (.json) | raw | gzip, **byte-identical** after gunzip | gzip | no |
| 4 | Media / binaries | raw, stored in the site tree | Sample objects happened to be gzip-encoded and are byte-identical after gunzip. Gzip is not required; migration will store binary media uncompressed. | omit `Content-Encoding` | no |
| 5 | Folders | `{folder}.props` (body `{}`, no metadata) | `{folder}/.props` (body `{}` gzipped, with `doc-id`, `last-modified-by`, `uncompressed-length`) | move the marker + generate metadata | no |
| 6 | Object metadata | doc/sheet: `id, path, preparsingstore, timestamp, users, version`; media: `id, path, timestamp, users` | all kinds: `doc-id, last-modified-by, uncompressed-length` | `doc-id` ← new ULID; `last-modified-by` ← `users[0].email`; the original `timestamp` has no slot | **yes**: `LastModified` = migration time |
| 7 | Versions | `.da-versions/{id}/{uuid}.{ext}` + metadata `label, path, timestamp, users`; html/json only | `.versions/{doc-id}/{ulid}` + `doc-path-hint, doc-last-modified, doc-last-modified-by, version-by, version-comment[, version-operation]` | `version-comment` ← `label` (same values: Previewed / Published); `doc-last-modified` ← ISO(`timestamp`); `version-by` ← user of the audit line; ULID seeded with the audit event time | **yes**: version date = `LastModified` (migration time) |
| 7b | Version semantics | Snapshot labelled by the da-live preview/publish actions | Same (Previewed/Published), plus automatic `delete` versions | 1:1 | no |
| 8 | Audit log | `audit.txt` TSV, one line per edit session (30 min collapse) and one per labelled version | **none** | Lines with a versionId give the version date and author; other lines have no target | **yes** (edit-only events) |
| 9 | Object identity | `id` UUID | `doc-id` ULID (also on folders and media) | new ULID per object; keep `id` → `doc-id` in the migration manifest | no |
| 10 | Delete / trash | **da-live** moves the item client-side to `/.trash/{name}-{iso-date}.{ext}`; `id` is kept, so versions remain attached | **API** soft delete: `delete` version, then move to `/.trash/{name}`. Emptying the trash removes the trash object; versions stay as orphans | `.trash/x-<date>.html` → `.trash/x-<date>.html` (keep the name to avoid collisions) | no |
| 10b | Trash metadata | `path` keeps the original path | `DELETE` sets `doc-path` (code and tests are correct). The sample object was **not** trashed: its `doc-id` was minted at write time (ULID 15:19:41.852Z), and it has no delete version, so it was a direct PUT/POST into `.trash/`. Reported as [adobe/helix-api-service#456](https://github.com/adobe/helix-api-service/issues/456) | migration sets `doc-path` itself (R5) | no |
| 11 | Comments | `.da/comments/{id}/*.json` | comment UI not supported | JSON files copied at their original paths using ordinary content rules; no document-ID reattachment | yes: files preserved, comment functionality not restored |
| 12 | Config / ACL | KV `DA_CONFIG` | helix config | out of scope of the source bus | - |

### Open items from the run
- Version body: da stores the body *at label time*, same as hlx6 (copy of the current object). Bodies to be compared once the samples have identical histories.
- da version `timestamp`/`users` = state of the doc *before* the snapshot; the version creation time is on the matching `audit.txt` line (e.g. version `2f34ce98…` has `timestamp` 1790864889099, while its audit line has 1790864951605).
