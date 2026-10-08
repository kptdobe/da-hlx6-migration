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

Proposed hlx6 change, tracked in [adobe/helix-api-service#458](https://github.com/adobe/helix-api-service/issues/458): honor optional user metadata, falling back to `LastModified`:
- `doc-last-modified` on current objects, for GET/HEAD
- `version-date` on version objects, for the versions list

The folder listing can't use it without a HEAD per item; that is acceptable or can be solved separately.
The migration writes these metadata keys **now**, so no second pass is needed once the change is supported.

## 2. Object rules

| # | da object | hlx6 key | Body | hlx6 metadata | Notes |
|---|---|---|---|---|---|
| R1 | `{o}/{s}{p}.html` | `{o}/{s}{toHlx6Path(p)}.html` | rewrite images (R9), gzip | common (§3) | |
| R2 | `{o}/{s}{p}.json` | idem `.json` | as-is, gzip | common | byte-identical after gunzip |
| R3 | `{o}/{s}{p}.{gif,ico,jpeg,jpg,mp4,pdf,png,svg}` | idem | raw bytes, uncompressed; do not set `Content-Encoding: gzip` | common | even if the source sample object is gzip-encoded, decode before migration |
| R4 | `{o}/{s}{f}.props` | `{o}/{s}{toHlx6Path(f)}/.props` | `{}`, gzip, `application/json` | common | only where da has a marker; implicit folders stay implicit |
| R5 | `{o}/{s}/.trash/{name}` | `{o}/{s}/.trash/{name}` (keep the dated name) | per R1-R4 | common + `doc-path` = `/` + `sitePath(path)` | `doc-id` kept from the same da `id`, so its versions stay attached |
| R6 | `.da-versions/{id}/{vid}.{ext}` | `{o}/{s}/.versions/{docId(id)}/{versionUlid}` (no extension) | preserve raw body; text may be gzip-encoded, binary media remains uncompressed | §4 | |
| R7 | `.da-versions/{id}/` with no live or trash doc | same as R6 (orphan versions) | | §4 | hlx6 behaves the same after the trash is emptied |
| R8 | `.da-versions/{id}/audit*.txt` | not written to the source bus | - | - | used as input for §4; raw files archived with the migration manifest. **Review**: acceptable to drop edit-only events from the UI? |
| R9 | `<img src>`, `<source srcset>` in html | - | rewrite to **relative** `./media_{hash}.{ext}` after uploading the image to the hlx6 site's media bus with the **media API** (see §8) | - | covers previewed and never-previewed pages the same way |
| R10 | `.da/**` | ordinary path mapping under `{o}/{s}/.da/` | per R1-R4 | common | no folder-specific exception or exclusion |
| R11 | `.da/comments/**` | ordinary path mapping per R10 | JSON per R2 | common | data copied; no comment-ID reattachment or comment UI support |
| R12 | unsupported extensions, `*.ext.props` sidecars | not migrated | - | - | pre-flight blocking / warning, independent of folder name |

## 3. Common metadata (current and trashed objects)

| hlx6 key | Value |
|---|---|
| `doc-id` | `docId(da id)`: ULID with **time** = earliest known event of the doc (first audit line, else `timestamp`) and **random part** = hash(da `id`). Deterministic, so re-runs are idempotent |
| `last-modified-by` | `users[0].email` from the da metadata, else `anonymous` |
| `uncompressed-length` | byte length of the original body (before optional text gzip) |
| `doc-last-modified` | ISO of the da `timestamp` (see §1; ignored by hlx6 until supported) |
| `da-id` | da `id`, for traceability |

Headers: `Content-Type` from the extension (hlx6 `CONTENT_TYPES`). Text/source bodies may be gzip-encoded; never gzip binary media.

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
| Unsupported extensions | blocking |
| Path sanitization collisions | blocking |
| Keys not in sanitized form (renamed on hlx6) | warning |
| Version folders without a live or trashed doc (migrated as orphans, R7) | warning |
| File property sidecars with no mapping | warning |

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
- Every `./media_{hash}` referenced by a migrated page exists in `helix-media-bus/{hlx6-content-bus-id}/`

## 8. Images (R9): upload procedure

### The official procedure
helix-api-service exposes `POST https://api.aem.live/{org}/sites/{hlx6-site}/media/` (`src/media/handler.js`, permission `media:upload`). It accepts either the raw bytes (`Content-Type: image/...`) or `{"url": "..."}`. It:
1. detects the type and rejects unsupported types (415)
2. preprocesses and validates the file: size limits per type (site config `limits.preview.*`), and SVG checked for scripts and event handlers (409 when rejected). The regular request body is limited to about 5 MB by API Gateway/Lambda; this is an upload-path limit, not a media delivery limit. See [helix-api-service issue #403](https://github.com/adobe/helix-api-service/issues/403) for the proposed direct/presigned upload path.
3. stores it with `@adobe/helix-mediahandler` (`storeBlob`) under `{hlx6-content-bus-id}/{hash}`, with `alg`, `agent`, `width`, `height` metadata, and the R2 mirror if the deployment enables it. An existing hash is not uploaded again.
4. returns `{ uri: "https://main--{site}--{org}.aem.page/media_{hash}.{ext}", meta }`

The hash is `"1" + sha1(contentLength + first 8 KiB)` (`src/media.js` `mediaHash`, verified against a real image). It is the same on every site. With the team's stable `contentBusId` decision, a da page's previewed media and the hlx6 project use the same `{contentBusId}/{hash}` object; reuse it if present. If the object is absent (for example, the page was never previewed), upload through the media API into that same site-scoped folder.

### Per image
1. Compute the media hash from the available bytes and check `helix-media-bus/{hlx6-content-bus-id}/{hash}`. If present, reuse it without uploading.
2. If missing, fetch the image bytes from the original URL (`raw.githubusercontent.com`, `content.da.live` with the DA token, etc.) and `POST` the bytes to the hlx6 media API. Bytes are preferred over `{url}`: no 5 s fetch timeout, no auth to forward, same result.
3. Rewrite `src`/`srcset` to `./media_{hash}.{ext}`, using the `uri` returned by the API or the verified existing hash.
4. On failure (fetch 404, upload-size limit, 409 validation, 415 type): log it in the manifest and report it. What goes into the page is a decision (see below).

### Why the API and not a direct media-bus write
- Same validation as an author upload (size limits, SVG sanitization), so we never store a file hlx6 would refuse.
- R2 mirroring and any future media bookkeeping stay the API's responsibility.
- The migration role needs **no write access to `helix-media-bus`**, only read on the da folder (§IAM).
- Volume is bounded: one call per **distinct** image per site, and existing hashes are skipped server-side.

With a stable `contentBusId`, previewed da images are already in the target site's media folder; no media-bucket copy is needed. For never-previewed images above the regular endpoint's request-size limit, the migration needs the direct/presigned upload flow in issue #403 before it can ingest them. The migration role still needs no media-bucket write permission.

### Decision needed
Images that cannot be uploaded (broken URL, too large, rejected SVG):
- (a) keep the external URL in the stored HTML. The page is stored, but saving it from the hlx6 editor later fails until the image is fixed (PUT rejects external images).
- (b) replace the image with a placeholder and report it.
- (c) do not migrate the page; report it.

Proposal: **(a)**, with a blocking pre-flight count so the site owner fixes them first.
