# 02 - Storage model: da vs hlx6 (derived from source code)

Versions analysed:
- da-admin `1.15.0` (3267d41)
- helix-api-service `v1.83.0` (98075fb)
- @adobe/helix-shared-storage `2.1.5`
- da-live `1.0.3` (016606ba)

Everything in this document must be confirmed on real data in Phase 3 (see [03](03-content-structure-differences.md)).

## 1. Key layout

| Aspect | da (R2 `aem-content`) | hlx6 (S3 `helix-source-bus`) |
|---|---|---|
| Document key | `{org}/{site}/{path}.{ext}` | `{org}/{site}/{path}.{ext}` |
| Case | **Whole path lowercased** (`daCtx.js`: `pathname.toLowerCase()`) | Basename **sanitized** by `sanitizePath()` (helix-shared-string `sanitizeName`: lowercase, non `[a-z0-9]` → `-`). PUT rejects non-sanitized paths with 400 |
| Allowed extensions | Any | Only `.gif .html .ico .jpeg .jpg .json .mp4 .pdf .png .svg` (`source/utils.js` `CONTENT_TYPES`), otherwise **415** |
| Folder marker | Sibling object `{org}/{site}/{folder}.props` | Child object `{org}/{site}/{folder}/.props` (body `{}`, `application/json`) |
| Hidden / reserved | `.da-versions/`, `*.props`, `.da/` (e.g. `.da/comments/{docId}`) | `.versions/`, `.trash/`, `.props` |

## 2. Document object

| Aspect | da | hlx6 |
|---|---|---|
| Body encoding | Raw | Text/source objects are commonly gzip-encoded. Encoding is not mandatory; binary media should be stored uncompressed (no `Content-Encoding: gzip`). The sample's compressed image objects are observed legacy state, not a migration requirement. |
| Content-Type | From the request (`type`) | From the extension |
| Metadata | `id` (UUID), `version` (UUID, html/json only), `users` (JSON array of `{email}`), `timestamp` (epoch ms string), `path` (`site/path`), `preparsingstore` | `doc-id` (**ULID**), `last-modified-by` (email or `anonymous`), `uncompressed-length` |
| Last modified | `timestamp` metadata **and** S3 LastModified | **S3 `LastModified` only**, which is not settable by a writer |
| Identity | `id` is kept across updates and regenerated on copy | `doc-id` is kept across updates and move; new ULID on copy; on copy-overwrite the destination doc-id is kept |
| HTML validation | None | Must parse and contain `<main>`. External `<img>`/`<picture><source>` URLs are rejected on PUT. On POST they are interned to the media bus. Kept URL prefixes: `https://main--{site}--{org}.aem.page/`, `.aem.live/`, `./media_`, DM delivery URLs |

## 3. Versions (key difference)

| Aspect | da | hlx6 |
|---|---|---|
| Location | `{org}/{site}/.da-versions/{fileId}/{versionId}.{ext}` | `{org}/{site}/.versions/{doc-id}/{ulid}` (**no extension**) |
| Version ID | UUID taken from the current object's `version` metadata | ULID generated at creation, so it sorts by creation time |
| Created when | On PUT, only for html/json **and** only when a `label` is given (explicit version), or for "Restore Point" when a non-empty html is overwritten by an empty body | Explicit `POST .../.versions`, and automatically before **delete** (`operation=delete`) and before **copy-overwrite** (`operation=copy`) |
| Created how | PutObject of the *previous* body | Server-side **CopyObject** of the current doc (gzip preserved) |
| Version metadata | `users`, `timestamp`, `path`, `label` | `doc-path-hint`, `doc-last-modified` (ISO), `doc-last-modified-by` (renamed from `last-modified-by`), `version-by`, `version-comment`, `version-operation`, plus the copied `doc-id` and `uncompressed-length` |
| Version date shown in UI | `timestamp` metadata | `version-date` = **S3 LastModified of the version object**, which is not settable |
| Audit / edit log | `.da-versions/{fileId}/audit.txt` (TSV: `timestamp users path versionLabel versionId`). Same-user edits within 30 min are collapsed; max 500 lines, then archived to `audit-{ts}.txt` | **None**. Every hlx6 record is a restorable version (`da-live/blocks/shared/version/helpers.js`) |
| Listing | `GET /versionlist` reads the audit lines | `GET .../.versions` lists the prefix and HEADs every object |
| Media versions | No (html/json only) | Any type can be versioned (copy) |

## 4. Delete, move, copy

| Op | da | hlx6 |
|---|---|---|
| Delete | **da-admin: hard delete**. But **da-live never hard-deletes**: it moves the item to `/.trash/{name}-{iso-date}.{ext}` (client-side, `da-list.js`), so `id` and versions stay attached. A hard delete only happens from inside `.trash` | **Soft delete**. The object gets a version (`operation=delete`), then is moved to `{org}/{site}/.trash/{name}` (or `.trash/{folder}/...`) with metadata `doc-path`. Name collisions get a `-{base36 ts}` suffix. Deleting inside `.trash` is a hard delete; versions are kept |
| Move / rename | da supports copy + delete; `id` is kept | Out of the supported hlx6 authoring workflow per team decision. Migration transfers current objects at their resulting paths; it does not replay move/rename operations. |
| Copy | New `id`, new version and a new audit entry | New `doc-id` (ULID) |

## 5. Media / binaries

| Aspect | da | hlx6 |
|---|---|---|
| Image upload in editor | Stored in R2 next to the doc (e.g. `.{docname}/image.png`), referenced as `https://content.da.live/{org}/{site}/...` | Interned into **`helix-media-bus`** (content-hashed `media_{hash}`), referenced by `./media_...`. The regular media API upload request is limited to about 5 MB by API Gateway/Lambda; this is an ingestion limit, not a delivery limit (see [issue #403](https://github.com/adobe/helix-api-service/issues/403)). |
| Standalone binaries | Any type in R2 | Only the allowed extension list; binary bodies should be stored uncompressed |

## 6. Config, permissions, collab

| Aspect | da | hlx6 |
|---|---|---|
| Org and site config, ACL | Cloudflare KV `DA_CONFIG` | helix config service / `configBus` (**TBD**, out of the source bus) |
| Comments | `{org}/{site}/.da/comments/{docId}/{commentId}.json`, keyed by the da doc `id` (read from the `x-da-id` header). da-live feature since 2026-09-10 (#1073) | **Not supported**. hlx6 returns no `x-da-id` header, so da-live disables comments (`editor-comments.js`). Needs: doc-id exposed by the API plus a comments store; then re-key from da `id` to hlx6 `doc-id` |
| Yjs / collab state | Not persisted in R2 (da-collab is in-memory + R2 doc) | N/A |

## 7. Side effects of API writes (Q3: does a direct S3 write skip anything?)

**hlx6 `/source` handlers** (`src/source/*`): **no non-S3 side effects**. There are no SQS, SNS, EventBridge, DynamoDB, audit-batch, index or purge calls in the write paths.
- Preview reads the source bus lazily (`contentproxy/source/sourcebus.js`) and interns images at preview time.
- **Conclusion:** writing directly to `helix-source-bus` is equivalent to source API writes only if we reproduce object metadata (`doc-id`, `last-modified-by`, `uncompressed-length`), `.props` markers and version metadata. Do not gzip binary media. Image ingestion should use the media API (including its validation and storage bookkeeping).

**da-admin**: the only side effect is the `notifyCollab` call on delete and update. It is irrelevant for migration reads.

## 8. Lossy points identified so far
1. **Timestamps**:
   - The current document `LastModified` and the version `version-date` are S3 system values, so they become the migration time.
   - The original values can only be carried in metadata (`doc-last-modified`, plus a proposed `x-migrated-*`).
   - The UI shows `version-date` first, so a client or API change is needed to display original dates. **Decision needed.**
2. **Audit-only entries** (da edits without a version snapshot) have no hlx6 equivalent. **Decision needed:** drop them, store them as an archived sidecar, or convert them.
3. **IDs**: da UUID `id`/`version` vs hlx6 ULID `doc-id`/version. A ULID can encode the original timestamp (`ulid(seedTime)`), which preserves ordering.
4. **Paths**: da lowercases the whole path; hlx6 sanitizes basenames. Names with `_`, `.`, spaces or unicode may map to a different key, which creates possible **collisions**.
5. **Unsupported extensions** in da (anything outside the 10 types) cannot be stored in hlx6.
6. **Image references** to `content.da.live` are invalid in hlx6 HTML. The images must be interned into the media bus and the URLs rewritten.
7. **Orphaned da versions** (of hard-deleted docs) have no live doc on hlx6. They could go into `.trash` with versions.
