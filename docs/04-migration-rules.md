# 04 - Migration rules (v1, for review)

Based on [02](02-storage-model.md) (code) and [03](03-content-structure-differences.md) (sample data).
Notation: `{o}/{s}` = `{org}/{site}`; `sitePath(p)` = da `path` metadata without its leading `{site}/`.

## 1. Dates: why they differ, and what we can do

Re-creating everything from scratch does **not** let us set the dates, because hlx6 does not store dates in metadata. It reads the **S3 system `LastModified`**, which S3 sets to the time of the write and does not let any client override (neither `PutObject` nor `CopyObject`).

| Date shown | Where hlx6 reads it | Settable by migration? |
|---|---|---|
| Document `Last-Modified` (GET/HEAD) | S3 `LastModified` of the object (`source-client.js` `getFileHeaders`) | **no** |
| Folder listing `last-modified` | S3 `LastModified` from `ListObjectsV2` (`folder.js`) | **no** |
| Version date (`version-date`, shown by da-live) | S3 `LastModified` of the version object (`versions.js`) | **no** |
| Version `doc-last-modified` / `doc-last-modified-by` | user metadata | **yes** |
| Version ordering | ULID of the version key, sorted by name | **yes** (ULIDs seeded with the original time) |

Consequences:
- **Order** is preserved: version ULIDs are generated from the original timestamps.
- **Dates** on hlx6 show the migration time until hlx6 supports an override.

Proposed hlx6 change, to be raised once the rules are reviewed: honor an optional user metadata date, falling back to `LastModified`:
- `last-modified` on current objects, for GET/HEAD
- `version-date` on version objects, for the versions list

The folder listing can't use it without a HEAD per item; that is acceptable or can be solved separately.
The migration writes these metadata keys **now**, so no second pass is needed once the change is supported.

## 2. Object rules

| # | da object | hlx6 key | Body | hlx6 metadata | Notes |
|---|---|---|---|---|---|
| R1 | `{o}/{s}{p}.html` | `{o}/{s}{toHlx6Path(p)}.html` | rewrite images (R9), gzip | common (§3) | |
| R2 | `{o}/{s}{p}.json` | idem `.json` | as-is, gzip | common | byte-identical after gunzip |
| R3 | `{o}/{s}{p}.{gif,ico,jpeg,jpg,mp4,pdf,png,svg}` | idem | as-is, gzip | common | hlx6 gzips media too |
| R4 | `{o}/{s}{f}.props` | `{o}/{s}{toHlx6Path(f)}/.props` | `{}`, gzip, `application/json` | common | only where da has a marker; implicit folders stay implicit |
| R5 | `{o}/{s}/.trash/{name}` | `{o}/{s}/.trash/{name}` (keep the dated name) | per R1-R4 | common + `doc-path` = `/` + `sitePath(path)` | `doc-id` kept from the same da `id`, so its versions stay attached |
| R6 | `.da-versions/{id}/{vid}.{ext}` | `{o}/{s}/.versions/{docId(id)}/{versionUlid}` (no extension) | as-is (+ R9 for html), gzip | §4 | |
| R7 | `.da-versions/{id}/` with no live or trash doc | same as R6 (orphan versions) | | §4 | hlx6 behaves the same after the trash is emptied |
| R8 | `.da-versions/{id}/audit*.txt` | not written to the source bus | - | - | used as input for §4; raw files archived with the migration manifest. **Review**: acceptable to drop edit-only events from the UI? |
| R9 | `<img src>`, `<source srcset>` in html | - | rewrite to **relative** `./media_{hash}.{ext}`; copy `media_{hash}` from the da site's media-bus folder (`{daContentBusId}/{hash}`, uploaded when da previewed the page) to `{targetContentBusId}/{hash}` (server-side copy) | - | hlx6 accepts `./media_*` as-is. Images of pages never previewed on da are not in the media bus: URL kept and reported |
| R10 | `.da/comments/**` | not migrated | - | - | pre-flight **blocking** |
| R11 | other extensions, `*.ext.props` sidecars, other `.da/**` | not migrated | - | - | pre-flight blocking / warning |

## 3. Common metadata (current and trashed objects)

| hlx6 key | Value |
|---|---|
| `doc-id` | `docId(da id)`: ULID with **time** = earliest known event of the doc (first audit line, else `timestamp`) and **random part** = hash(da `id`). Deterministic, so re-runs are idempotent |
| `last-modified-by` | `users[0].email` from the da metadata, else `anonymous` |
| `uncompressed-length` | byte length of the body before gzip |
| `last-modified` | ISO of the da `timestamp` (see §1; ignored by hlx6 until supported) |
| `da-id` | da `id`, for traceability |

Headers: `Content-Type` from the extension (hlx6 `CONTENT_TYPES`), `Content-Encoding: gzip`.

## 4. Version metadata

da facts (from the sample):
- version `timestamp`/`users` describe the doc **before** the snapshot, i.e. its last modification
- the time and author of the **version creation** are on the `audit.txt` line whose versionId matches

| hlx6 key | Value |
|---|---|
| version key ULID | time = audit line timestamp of this versionId (fallback: version `timestamp`); random part = hash(da version id) |
| `doc-id` | `docId(da id)` |
| `doc-path-hint` | `/` + `sitePath(path)` mapped with `toHlx6Path` |
| `doc-last-modified` | ISO of the version `timestamp` |
| `doc-last-modified-by` | version `users[0].email` |
| `version-by` | audit line `users[0].email` (fallback: `doc-last-modified-by`) |
| `version-comment` | da `label` (`Previewed`, `Published`, `Restore Point`, custom) |
| `version-date` | ISO of the audit line timestamp (see §1) |
| `uncompressed-length` | as above |
| `da-version-id` | da version id, for traceability |

`version-operation` is not set; da has no equivalent.

## 5. Pre-flight checks
Implemented in `bin/preflight.js`.

| Check | Severity |
|---|---|
| `.da/comments/` objects present (comments are not migrated) | blocking |
| Unsupported extensions | blocking |
| Path sanitization collisions | blocking |
| Keys not in sanitized form (renamed on hlx6) | warning |
| Version folders without a live or trashed doc (migrated as orphans, R7) | warning |
| Objects with no mapping (sidecars, other `.da/`) | warning |

## 6. Execution invariants
- Pre-flight first. A blocking check stops the run unless explicitly acknowledged.
- Dry-run by default; `-x` writes.
- Write order per document: versions first, then the current object.
- Conditional writes (`IfNoneMatch: *`). Existing identical objects (same `da-id` / `da-version-id`) count as done, so runs are resumable and idempotent.
- The manifest (JSONL) records `daKey → hlx6Key, docId, status`, plus the archived audit files.

## 7. Verification
- Counts per kind: da current + trash = hlx6 current + trash; da versions = hlx6 versions
- Body equality per object after gunzip (html: after image-URL normalization)
- Per doc: version count and ULID order match the audit order
- Sample preview through `api.aem.live` for N random documents
