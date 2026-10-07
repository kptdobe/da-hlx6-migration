# da-hlx6-migration

Tooling and analysis to migrate DA projects from the **da** backend (da-admin, Cloudflare R2)
to the **hlx6** backend (helix-api-service, AWS S3 "source bus").

## Objectives
1. Utils to read and write both backends at the storage level.
2. An exhaustive list of content structure differences between the two backends.
3. A migration util writing directly to S3, able to handle projects with millions of objects.

## Docs
- [00 - Plan](docs/00-plan.md)
- [01 - Access & tooling](docs/01-access-and-tooling.md)
- [02 - Storage model: da vs hlx6 (from source code)](docs/02-storage-model.md)
- [03 - Content structure differences (empirical, sample projects)](docs/03-content-structure-differences.md)
- [04 - Migration rules](docs/04-migration-rules.md)
- [05 - Architecture (ADR)](docs/05-architecture.md)
- [Open questions](docs/open-questions.md)

## Reference projects
- da: https://da.live/#/kptdobe/sample-content-da
- hlx6: https://da.live/#/kptdobe/sample-content-hlx6

## Usage (all read-only)
Credentials and runtime settings are loaded from the local, git-ignored `.dev.vars` file; its non-empty values take precedence over shell variables. It holds the R2 read-only token, AWS profile/role settings, and target media API token. Keep its mode owner-only (`chmod 600 .dev.vars`).

```bash
npm install
node bin/dump.js -b da   <org/site>             # download a site to analysis/da/<org>/<site>
node bin/dump.js -b hlx6 <org/site>             # download a site to analysis/hlx6/<org>/<site>
node bin/compare.js <da-dump> <hlx6-dump>       # structural diff
node bin/preflight.js -v <org/site>             # migration blockers for a da site
npm test && npm run lint
```

The sample migration command is pinned to `kptdobe/sample-content-da` → `kptdobe/sample-content-hlx6-migrated` and is dry-run by default:

```bash
node bin/migrate.js --refresh-source
```

Execution additionally requires the dedicated `da-hlx6-migration` AWS role, the R2 read-only credentials, and a target-scoped `media:upload` token. Put all of these in `.dev.vars`, then run `node bin/migrate.js --refresh-source -x`. It has no delete path and refuses unplanned target objects.

To rerun and overwrite all planned sample content, use `node bin/migrate.js --refresh-source --overwrite -x`. Without `-x`, this only plans overwrites. The target remains pinned, unplanned target objects still block migration, and config conflict protection is unchanged.

Project config is read from `https://admin.da.live/config/{org}/{da-site}` and rewritten into `editor.da` of the target site's `config.json`, using a property-only `POST` to `https://api.aem.live/{org}/sites/{hlx6-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; different existing sheet rows are rejected. Previously migrated configs containing metadata or sheet wrappers are converted only when their rows match the source. Dry runs only read and report the planned config migration.

Set `HLX6_CONFIG_TOKEN` to a target-scoped token with `config:read` and `config:write` permissions when DA config exists; the media-upload token alone is not sufficient. DA authentication uses the local `da-auth/src/cli.js token` helper, capturing its output without printing the token. Override its path with `DA_AUTH_CLI`, or supply a helper-issued `DA_CONFIG_TOKEN` in the local environment file. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The run report includes `projectConfig` status and API URLs, not config contents or credentials.
