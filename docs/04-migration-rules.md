# 04 - Migration rules (draft, based on 02; validated by 03)

| Object type (da) | Target key (hlx6) | Body | Metadata | Category |
|---|---|---|---|---|
| `{o}/{s}/{p}.html` | `{o}/{s}/{sanitize(p)}.html` | Rewrite image URLs (see Media); gzip | `doc-id` = ULID(seed = da `timestamp`), `last-modified-by` = first of da `users`, `uncompressed-length`, `x-da-id` = da `id` (traceability) | transform |
| `{o}/{s}/{p}.json` | same rule | gzip | as above | copy + rewrite metadata |
| `{o}/{s}/{p}.{allowed binary}` | same rule | gzip (as the API does) | as above | copy + rewrite metadata |
| `{o}/{s}/{p}.{other ext}` | - | - | - | **report, not migrated** (decision needed) |
| `{o}/{s}/{f}.props` | `{o}/{s}/{f}/.props` (body `{}`) | `{}` | `doc-id` | generate |
| `.da-versions/{id}/{vid}.{ext}` | `.versions/{doc-id}/{ULID(seed = version timestamp)}` | gzip | `doc-path-hint`, `doc-last-modified` (ISO of da `timestamp`), `doc-last-modified-by`, `version-by`, `version-comment` = da `label`, `doc-id` | transform |
| `.da-versions/{id}/audit*.txt` | **TBD**: drop / sidecar / synthesize versions | - | - | decision needed |
| Versions of hard-deleted docs | `.trash/{name}` (last version as body) + `.versions/{doc-id}/...` | | `doc-path` = original path | generate (decision needed) |
| `.da/comments/...` | TBD | | | TBD |
| `content.da.live` images | `helix-media-bus` `media_{hash}` + URL rewrite to `./media_{hash}.{ext}` | | media bus metadata as written by `@adobe/helix-mediahandler` | generate |

## Invariants
- The mapping is deterministic, so re-runs are idempotent: `doc-id` is derived from the da `id` plus its timestamp seed, and the version ULID from the da version id plus its timestamp.
- Sanitization collisions (two da keys mapping to one hlx6 key) are detected **before** writing and reported.
- Writes are conditional (`IfNoneMatch: *`) unless `--overwrite` is set.

## Verification
- Object counts per type and per folder
- Body hash per current object (after gunzip and URL-rewrite normalization)
- Version count per document = da versions (+ synthesized ones, if that is decided)
- Sample preview through `api.aem.live` for N random documents
