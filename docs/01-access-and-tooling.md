# 01 - Access & tooling

## da backend
| Item | Value | Source |
|---|---|---|
| Storage | Cloudflare R2, S3-compatible API | da-admin `src/storage/utils/config.js` |
| Bucket | `env.AEM_BUCKET_NAME` → `aem-content` in prod | da-admin `src/utils/daCtx.js` |
| Credentials | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_DEF_URL` (endpoint), region `auto`, `forcePathStyle` | da-magic `traverse/s3-utils.js` (read from `.dev.vars`) |
| Config | Cloudflare KV `DA_CONFIG`, **not** in R2 | da-admin `src/storage/kv/*` |
| API | `https://admin.da.live/source/{org}/{site}/...` | |

## hlx6 backend
| Item | Value | Source |
|---|---|---|
| Storage | AWS S3 via `@adobe/helix-shared-storage` 2.1.5 | helix-api-service |
| Source bucket | `bucketMap.source`; defaults to **`helix-source-bus`** unless `HELIX_BUCKET_NAMES` (JSON) overrides it | shared-storage `parseBucketNames()` |
| Media bucket | `bucketMap.media` → `helix-media-bus` | `storage.mediaBus()` |
| R2 mirror | `sourceBus(disableR2 = true)` → **no R2 mirror** for source; S3 only | shared-storage `storage.js` |
| Credentials | AWS profile or role: **TBD** (read + write on `helix-source-bus`, read + write on `helix-media-bus`) | - |
| API | `https://api.aem.live/{org}/sites/{site}/source/...` | helix-api-service `src/index.js` |
| Site is hlx6? | `GET {HLX_ADMIN}/ping/{org}/{site}` returns the `x-api-upgrade-available` header | da-nx `nx2/utils/api.js` `isHlx6()` |

The prod bucket names must be confirmed from the deployed `HELIX_BUCKET_NAMES`.

## da-magic utils to copy
| Util | Purpose | Action |
|---|---|---|
| `traverse/s3-utils.js` | R2 client (keep-alive, 500 sockets), `.dev.vars` loader, listing | Copy and port to ESM; generalize to "S3-compatible client" for both R2 and S3 |
| `traverse/sharding.js` (+ test) | Prefix sharding for parallel listing of huge buckets | Copy as-is (ESM) |
| `traverse/traverse.js`, `list-folder.js` | Recursive listing | Copy and adapt |
| `read-s3-document.sh`, `read-s3-versions.sh` | Ad-hoc reads | Replace with Node CLIs |
| `encoding/*` | gzip detection and fixing | Reference only: hlx6 stores gzip bodies |

## Gate before Phase 3
Read-only access to `aem-content/kptdobe/sample-content-da/` and `helix-source-bus/kptdobe/sample-content-hlx6/` must be verified.
