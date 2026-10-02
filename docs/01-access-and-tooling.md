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
| Credentials | AWS KLAM role, account `118435662149`, region `us-east-1`, from `~/.aws/credentials` (temporary, refresh when expired). Read on `helix-source-bus` verified | - |
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
Read-only access verified on both sides (2026-10-01). R2 credentials: `.dev.vars` at the repo root (git-ignored, symlink to da-magic's) or `--dev-vars` / `$DA_DEV_VARS`.

## Least-privilege migration identity (required before any write)

The migration must never run with the personal KLAM role, which can write anywhere in the account. Two layers of protection:
1. **IAM** (hard limit, enforced by AWS): a dedicated role, `da-hlx6-migration-test`, that can only touch the test folders.
2. **Code** (`WRITE_ALLOWLIST` in `src/storage.js`): refuses any write outside the target before calling AWS.

### AWS role: [infra/aws/migration-policy.json](../infra/aws/migration-policy.json)

| Bucket | Folder | List | Read | Write |
|---|---|---|---|---|
| `helix-source-bus` | `kptdobe/sample-content-hlx6/` (reference) | yes | yes | **no** |
| `helix-source-bus` | `kptdobe/sample-content-hlx6-migrated/` (target) | yes | yes | yes |
| `helix-media-bus` | `cdb7c31a…` (sample-content-da media) | yes | yes | **no** |
| `helix-media-bus` | `8a228067…` (sample-content-hlx6-migrated media) | yes | yes | yes |
| `helix-config-bus` | the 3 site JSON files | no | yes | **no** |
| anything else | - | no | no | no |

- **No delete at all** (explicit Deny), and no ACL or bucket-config changes.
- Writes are `PutObject` only. A server-side media copy needs `GetObject` on the source and `PutObject` on the target, both covered.
- Buckets use SSE-S3 (`AES256`), so no KMS permission is needed.
- Both buckets have **versioning enabled**. An overwrite in the target never destroys data, and an admin can roll back.
- Cleaning up the target site (e.g. before re-running a test) is done by an admin, not by this role.

### Creating it (to be done by an account admin, not by the migration tooling)
```bash
# edit the principal in infra/aws/trust-policy.json first
aws iam create-role --role-name da-hlx6-migration-test \
  --assume-role-policy-document file://infra/aws/trust-policy.json \
  --max-session-duration 3600
aws iam put-role-policy --role-name da-hlx6-migration-test \
  --policy-name da-hlx6-migration-test \
  --policy-document file://infra/aws/migration-policy.json
```

Local profile in `~/.aws/config`, assumed from the KLAM credentials:
```ini
[profile da-hlx6-migration]
role_arn = arn:aws:iam::118435662149:role/da-hlx6-migration-test
source_profile = default
role_session_name = acapt
region = us-east-1
```
Run the tooling with `AWS_PROFILE=da-hlx6-migration`.

### Verification before the first write
```bash
AWS_PROFILE=da-hlx6-migration aws sts get-caller-identity          # must show da-hlx6-migration-test
# each of these must be AccessDenied:
AWS_PROFILE=da-hlx6-migration aws s3 ls s3://helix-source-bus/adobe/
AWS_PROFILE=da-hlx6-migration aws s3api put-object --bucket helix-source-bus --key kptdobe/sample-content-hlx6/deny-test.html --body /dev/null
AWS_PROFILE=da-hlx6-migration aws s3api delete-object --bucket helix-source-bus --key kptdobe/sample-content-hlx6-migrated/deny-test.html
```

### R2 (da side, read only)
R2 API tokens can be scoped per bucket, not per prefix. Use a **new token**: "Object Read only" on `aem-content`, with an expiry. Do not use the da-magic token, which has broader rights. Store it in this repo's `.dev.vars` (git-ignored). The tooling never writes to R2: there is no R2 write path in the code.
