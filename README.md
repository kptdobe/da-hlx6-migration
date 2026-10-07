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

## Main migration flow

`content.fixedContentBusId` keeps the existing content and media bus when the site's content source changes from DA to HLX6. The property is owned by config-storage, not this migration tool; wait until the [config-storage support](https://github.com/adobe/helix-config-storage/pull/326) is deployed before using it.

1. Record the DA site's current effective `contentBusId`. After config-storage support is deployed, set `content.fixedContentBusId` to that value in the site config that will be switched, while its source URL still points to DA. Use the same ID for both the DA and HLX6 migration scopes so media is read from and written to the same bus.
2. Check blockers and inspect the source and target state. Keep DA authoring active for this read-only preparation.

	```bash
	node bin/preflight.js -v <org>/<da-site>
	node bin/dump.js -b da <org>/<da-site>
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	```

3. Run a dry-run with the project-specific migration runner and review its report. Resolve blockers and target conflicts before execution. The current `bin/migrate.js` dry-run command is pinned to the sample project; see CLI usage below.

4. Freeze DA edits, then execute with a fresh source snapshot. Keep the freeze in place through verification and cutover. The sample runner requires `--refresh-source -x`; a production runner must likewise migrate the final frozen snapshot.

5. Dump the migrated HLX6 target and compare it with the DA snapshot. Confirm the expected content, versions, and media before changing the site's source URL.

	```bash
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	node bin/compare.js analysis/da/<org>/<da-site> analysis/hlx6/<org>/<hlx6-site>
	```

6. Change `content.source.url` to the HLX6 source and leave `content.fixedContentBusId` set to the recorded DA ID. Verify preview/live content and media, then resume authoring on HLX6. For rollback, restore the DA source URL without removing the fixed ID.

The current `bin/migrate.js` is pinned to the sample project; it is not yet a general-purpose production runner. A production migration needs its target, bus IDs, and IAM scope configured for that project. The runner copies a fresh snapshot; it does not provide live delta synchronization or delete source objects.

## CLI usage
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

Execution additionally requires the dedicated `da-hlx6-migration` AWS role, the R2 read-only credentials, and a DA auth token whose identity is authorized for DA config/image reads and target `media:upload`, `config:read`, and `config:write`. The runner obtains one token from the local `da-auth/src/cli.js token` helper, or uses `DA_CONFIG_TOKEN` if supplied, and shares it across these API calls. No separate target-specific bearer tokens are required. Put the AWS and R2 settings in `.dev.vars`, then run `node bin/migrate.js --refresh-source -x`. It has no delete path and refuses unplanned target objects.

To rerun and overwrite all planned sample content, use `node bin/migrate.js --refresh-source --overwrite -x`. Without `-x`, this only plans overwrites. The target remains pinned, unplanned target objects still block migration, and config conflict protection is unchanged.

Project config is read from `https://admin.da.live/config/{org}/{da-site}` and rewritten into `editor.da` of the target site's `config.json`, using a property-only `POST` to `https://api.aem.live/{org}/sites/{hlx6-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; different existing sheet rows are rejected. Previously migrated configs containing metadata or sheet wrappers are converted only when their rows match the source. Dry runs only read and report the planned config migration.

The DA auth token is captured without printing it. Override the helper path with `DA_AUTH_CLI`, or supply a helper-issued `DA_CONFIG_TOKEN` in the local environment file. Confirm that the authenticated identity has all required permissions before execution. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The run report includes `projectConfig` status and API URLs, not config contents or credentials.
