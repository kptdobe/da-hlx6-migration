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
| R1 | `{o}/{s}{p}.html` | `{o}/{s}{toHlx6Path(p)}.html` | rewrite images (R9), then same-site DA URLs (R13), gzip | common (§3) | |
| R2 | `{o}/{s}{p}.json` | idem `.json` | rewrite same-site DA URLs in string tokens (R13), gzip | common | other bytes, including numeric precision and formatting, preserved |
| R3 | `{o}/{s}{p}.{avif,gif,ico,jpeg,jpg,mp4,pdf,png,svg}` | idem | raw bytes except SVG URL rewrites (R13), uncompressed; do not set `Content-Encoding: gzip` | common | AVIF uses `image/avif`; even if the source sample object is gzip-encoded, decode before migration |
| R4 | `{o}/{s}{f}.props` | `{o}/{s}{toHlx6Path(f)}/.props` | `{}`, gzip, `application/json` | common | only where da has a marker; implicit folders stay implicit |
| R5 | `{o}/{s}/.trash/{name}` | `{o}/{s}/.trash/{name}` (keep the dated name) | per R1-R4 | common + `doc-path` = `/` + `sitePath(path)` | `doc-id` kept from the same da `id`, so its versions stay attached |
| R6 | `.da-versions/{id}/{vid}.{ext}` | `{o}/{s}/.versions/{docId(id)}/{versionUlid}` (no extension) | text follows URL/image rewrites; binary media remains unchanged and uncompressed | §4 | |
| R7 | `.da-versions/{id}/` with no live or trash doc | same as R6 (orphan versions) | | §4 | hlx6 behaves the same after the trash is emptied |
| R8 | `.da-versions/{id}/audit*.txt` | `{o}/{s}/.versions/{docId(id)}/audit/{segment}.jsonl` | TSV to JSONL v1, gzip, `application/x-ndjson` | `doc-id`, `da-id`, `uncompressed-length` | active + archives, including orphan histories; see §4.1 |
| R9 | `<img src>`, `<source srcset>` in html | - | use API target keep rules; upload other image URLs including DA content URLs; rewrite successes to `./media_{hash}.{ext}`; failures follow R13 | - | errors and source-page references logged; migration continues (§8) |
| R10 | `.da/**` | ordinary path mapping under `{o}/{s}/.da/` | per R1-R4 | common | no folder-specific exception or exclusion |
| R11 | `.da/comments/**` | ordinary path mapping per R10 | JSON per R2 | common | data copied; no comment-ID reattachment or comment UI support |
| R12 | unsupported extensions, `*.ext.props` sidecars | not migrated | - | - | warning, independent of folder name; unsupported objects are listed with an exclusion reason and never written |
| R13 | same-source-owner/site URLs on `admin.da.live` or `content.da.live` | destination API source/config routes | rewrite in editor config, HTML, JSON and SVG, including trash/versions | update `uncompressed-length`; keep original `da-source-sha256` | other sites/owners, org-level URLs, published URLs and binaries untouched; unmappable admin routes retained with warnings |

R13 maps DA content paths to `/source/` (adding `.html` or directory `index.html`
where needed), admin `/source/` directly, admin `/list/` to a trailing-slash source
folder and site `/config/` to `/config/editor/da.json`. Queries, fragments and
encoded paths are retained. UUID version and copy/move URLs cannot be translated
by URL alone. See [Same-site DA URLs](../README.md#same-site-da-urls) for report fields
and config conflict rules. Generated audit records are not URL-rewritten.

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

### 4.1 Audit history

Target contract:
[adobe/helix-api-service#556](https://github.com/adobe/helix-api-service/pull/556)
and [adobe/helix-audit-logger#595](https://github.com/adobe/helix-audit-logger/pull/595).
Compatible reader/logger deployments are required before cutover.

Each DA file becomes one segment, ordered oldest first, without a 500-record
read limit. `audit.txt` becomes `audit/audit.jsonl`; archives become
`audit/{firstTimestamp16}-{firstActivityId}.jsonl`, using the first valid event.
Empty segments are retained; empty archives use time zero and a deterministic
file identity. Document IDs match current, trashed and orphan version objects.

| JSONL key | Value |
|---|---|
| `v` | `1` |
| `id` | deterministic ULID from the event timestamp, source key, record index and parsed event |
| `t` | original DA timestamp in Unix milliseconds |
| `op` | `version` if a version ID or label exists; otherwise `edit` (no inferred create/copy/trash) |
| `u` | all DA actor emails, lowercased; empty array if no actors were recorded |
| `p` | original site-relative path, stripping a legacy leading site segment if present |
| `label` | non-empty DA version label |
| `snapshot` | migrated version ULID, only if that snapshot is part of the migration plan |

DA does not retain the beginning of a collapsed edit session, so no `t0` is
invented. Three-column edit rows, legacy four-column rows (version ID only)
and five-column rows (label + version ID) are supported.

Malformed records are skipped individually, not blockers. The private report's
`malformed-audit-records` warning records the source key, 1-based line number,
raw line, error and `skipped-record` action. Progress logs omit the raw line.
The source snapshot retains the original files. Missing source bodies still
block migration. Events referencing missing/unsupported snapshots are retained
without `snapshot` and reported as `audit-snapshots-not-migrated`.

## 5. Pre-flight checks
Implemented in `bin/preflight.js`.

| Check | Severity |
|---|---|
| Unsupported files and paths (current content, trash, versions) | warning; listed and skipped, supported content proceeds |
| Actual duplicate target paths | blocking |
| Filename renames | not performed; compatibility report field has count zero |
| Version folders without a live or trashed doc (migrated as orphans, R7) | warning |
| File property sidecars with no mapping | warning |
| Malformed audit records (full validation only) | warning; log original records for analysis and skip them |
| Audit snapshots not migrated (full validation only) | warning; retain events without snapshot links |
| Same-site admin URLs without a URL-only API mapping (full validation only) | warning; retain URLs and report affected references |

## 6. Execution invariants
- Pre-flight first. A blocking check stops the run unless explicitly acknowledged.
- Dry-run by default; `-x` writes.
- Write order: versions first, then audit segments, then current objects.
- Conditional writes (`IfNoneMatch: *`). Existing identical objects (same `da-id` / `da-version-id`) count as done, so runs are resumable and idempotent.
- The source snapshot retains raw audit files; the migration report maps source keys to planned target keys and records write statuses and skipped audit records.

## 7. Verification
- Counts per kind: da current + trash = hlx6 current + trash; da versions = hlx6 versions
- Body equality per object after gunzip, accounting for reported same-site DA URL rewrites and HTML image replacements
- Per doc: version count and ULID order match the audit order
- Audit record counts include active and archived segments on both sides; HLX6 totals equal DA totals minus malformed records reported as skipped
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
1. Keep the api-service target prefixes: main target `.aem.page/` and `.aem.live/`, `./media_`, and HTTPS `/adobe/dynamicmedia/deliver/` URLs on any host. Other image references are upload candidates; this includes `https://content.da.live/{source-org}/{source-site}/...`. The migration parses each `srcset` candidate individually.
2. Fetch candidates and POST their bytes to the target media API, which handles hash deduplication. Send the DA token only to the exact `https://content.da.live` origin, never to lookalike hosts or third parties.
3. Rewrite successful uploads to the returned relative media path, then apply R13. Failed same-site DA URLs point to the migrated source API; other failed URLs and kept-prefix URLs remain unchanged.
4. Individual fetch/upload failures do not block migration: record each URL, error, source keys, and `kept-original-url` or `rewritten-to-source-api` action (with `targetUrl`) in `imageErrors` and warning entries. This deliberately differs from api-service POST's HTTP 400 on failure. Missing media credentials remain a fatal setup error.

### Why the API and not a direct media-bus write
- Same validation as an author upload (size limits, SVG sanitization), so we never store a file hlx6 would refuse.
- R2 mirroring and any future media bookkeeping stay the API's responsibility.
- The migration role needs **no write access to `helix-media-bus`**, only read on the da folder (§IAM).
- Volume is bounded: one call per **distinct** image per site, and existing hashes are skipped server-side.

With a stable `contentBusId`, previewed da images are already in the target site's media folder; no media-bucket copy is needed. For never-previewed images above the regular endpoint's request-size limit, the migration needs the direct/presigned upload flow in issue #403 before it can ingest them. The migration role still needs no media-bucket write permission.

### Decision needed
Image upload candidates that fail (broken URL, too large, rejected SVG):
- (a) keep the external URL in the stored HTML. The page is stored, but saving it from the hlx6 editor later fails until the image is fixed (PUT rejects external images).
- (b) replace the image with a placeholder and report it.
- (c) do not migrate the page; report it.

Current behavior: keep each failed image URL unchanged, log its error and source-page references, and continue migrating content. Failed images may remain unavailable and later API PUT/POST may still reject them; migration fallback does not alter api-service validation.
