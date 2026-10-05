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
Read-only access verified on both sides (2026-10-01). Migration credentials and runtime settings belong in this repo's local, git-ignored `.dev.vars`; do not symlink it to da-magic or another project's environment file. Use `chmod 600 .dev.vars` and never commit or share its contents.

## Migration identity: one shared role, scoped per migration

The migration never runs with a personal role, which can write anywhere in the account. It uses **one** role, `da-hlx6-migration`, created once. The role **has no access by itself**: every permission is tied to STS **session tags** that the tooling sets when it assumes the role for a given migration.

```mermaid
flowchart LR
  op[operator credentials] -- "AssumeRole + tags\norg, da-site, hlx6-site,\nda-content-bus-id, hlx6-content-bus-id" --> role[da-hlx6-migration role]
  role -- "policy variables\n${aws:PrincipalTag/...}" --> s3[(only the folders of this migration)]
```

Three independent layers:
1. **Trust policy** ([infra/aws/trust-policy.json](../infra/aws/trust-policy.json)): the role can only be assumed by the KLAM operator role, with the **exact 5 tags and values for the approved sample migration**. Other sites and media IDs are denied.
2. **Role policy** ([infra/aws/migration-role-policy.json](../infra/aws/migration-role-policy.json)): every resource is built from the tags, and a missing tag is an explicit Deny. Deleting and reconfiguring are always denied.
3. **Code** (`src/scope.js`): validates the values (`[a-z0-9-]`, hex ids, da ≠ hlx6 media folder) and refuses any write outside the scope before calling AWS.

### What one migration session can do

| Bucket | Folder (from tags) | List | Read | Write |
|---|---|---|---|---|
| `helix-source-bus` | `{org}/{hlx6-site}/` (hlx6 site) | yes | yes | yes |
| `helix-media-bus` | `{da-content-bus-id}/` (da site media) | yes | yes | **no** |
| `helix-media-bus` | `{hlx6-content-bus-id}/` (hlx6 site media) | yes | yes | **no** (images go through the media API, see [04 §8](04-migration-rules.md#8-images-r9-upload-procedure)) |
| `helix-config-bus` | `orgs/{org}/sites/{da-site}.json`, `{hlx6-site}.json` | no | yes | **no** |
| anything else | - | no | no | no |

Example tags for the test: `org=kptdobe`, `da-site=sample-content-da`, `hlx6-site=sample-content-hlx6-migrated`, `da-content-bus-id=cdb7c31a…`, `hlx6-content-bus-id=8a228067…`.

Notes:
- Writes are `PutObject` on the hlx6 site in the source bus only.
- Buckets use SSE-S3 (`AES256`), so no KMS permission is needed. Both buckets have **versioning enabled**, so an overwrite in the hlx6 site can be rolled back by an admin.
- Cleaning up an hlx6 site is done by an admin, never by this role.
- Role chaining caps a session at 1 h. The tooling refreshes credentials automatically, with the same tags (`createMigrationClient`).
- The da side (R2) is read-only and does not go through this role (see below).

### Remaining risk
The trust policy is intentionally pinned to the three approved sample identifiers for this test. Before reusing the role for another migration, an account admin must review and update the allowed tag values. The tooling also refuses to write into an hlx6 site that contains unrecognized objects.

Not verified yet: whether a `*` inside a substituted tag value acts as a wildcard. The code rejects such values, and the deny checks below test it explicitly.

### Creating it (once, by an account admin)
```bash
aws iam create-role --role-name da-hlx6-migration \
  --assume-role-policy-document file://infra/aws/trust-policy.json \
  --max-session-duration 3600
aws iam put-role-policy --role-name da-hlx6-migration \
  --policy-name da-hlx6-migration \
  --policy-document file://infra/aws/migration-role-policy.json
```

### Verification before the first write
Run as the operator. Assume with the test tags, then check that each of these is **AccessDenied**:
- list `s3://helix-source-bus/kptdobe/sample-content-hlx6/` (the reference site)
- put into `helix-source-bus/kptdobe/sample-content-hlx6/`
- put into `helix-media-bus/{da-content-bus-id}/`
- delete in `helix-source-bus/kptdobe/sample-content-hlx6-migrated/`
- AssumeRole without tags, with a missing tag, or with `hlx6-site=*`

And that listing and putting into `kptdobe/sample-content-hlx6-migrated/` succeed.

### R2 (da side, read only)
R2 API tokens can be scoped per bucket, not per prefix. Use a **new token**: "Object Read only" on `aem-content`, with an expiry. Do not reuse the da-magic token, which has broader rights. Store its `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_DEF_URL` in this repo's `.dev.vars`. The tooling never writes to R2: there is no R2 write path in the code.
