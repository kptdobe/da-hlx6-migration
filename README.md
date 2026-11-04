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

1. Record the DA site's current `contentBusId`. Set `content.fixedContentBusId` to `true` in the site config that will be switched, while its source URL still points to DA. When the source has this flag, the migration uses its `contentBusId` for both the DA and HLX6 scopes so media is read from and written to the same bus.
2. Check blockers and inspect the source and target state. Keep DA authoring active for this read-only preparation.

	```bash
	node bin/preflight.js -v <org>/<da-site>
	node bin/dump.js -b da <org>/<da-site>
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	```

3. Run `node bin/migrate.js <source-org/source-site> <target-org/target-site>` and review its dry-run report. Source and target may belong to different organizations. Resolve blockers and target conflicts before execution.

4. Freeze DA edits, then execute with a fresh source snapshot using `--refresh-source -x`. Keep the freeze in place through verification and cutover.

5. Dump the migrated HLX6 target and compare it with the DA snapshot. Confirm the expected content, versions, and media before changing the site's source URL.

	```bash
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	node bin/compare.js analysis/da/<org>/<da-site> analysis/hlx6/<org>/<hlx6-site>
	```

6. Change `content.source.url` to the HLX6 source and leave `content.fixedContentBusId` set to `true`. Verify preview/live content and media, then resume authoring on HLX6. For rollback, restore the DA source URL without removing the flag.

`bin/migrate.js` supports arbitrary source and target organizations/sites. Execution resolves and validates both content bus IDs from live site configs and assumes a migration role scoped to the target. Legacy string-valued `fixedContentBusId` settings remain supported. The runner copies a fresh snapshot; it does not provide live delta synchronization or delete source objects.

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

Migration is dry-run by default. Without site arguments it uses
`kptdobe/sample-content-da` → `kptdobe/sample-content-hlx6-migrated`.
For another site pair:

```bash
node bin/migrate.js --dry-run adobecom/da-events kptdobe/da-events-migrated
# Download and retain source content for body-dependent validation, without remote writes:
node bin/migrate.js --full-validation adobecom/da-events kptdobe/da-events-migrated
```

Default inventory uses listings, with no source body/header reads or DA
authentication unless folder exclusions require metadata reads (see below).
It is not a readiness guarantee: orphan detection, migration planning, image
planning, destination ownership and project-config comparison require full validation.
Reports include source/target stored object counts, byte totals, inventory
categories, warnings, blockers, skipped checks and resolved bus IDs.
Reports are owner-only JSON files under `analysis/`; `-o` selects a new path.
Full validation/execution retains an owner-only source snapshot under `tmp/`,
with bodies, a manifest and a completion marker. Incomplete snapshots cannot be
reused. `--source-dump <directory>` selects a local snapshot; `--refresh-source`
refreshes it from DA. Snapshots and reports contain confidential site data:
they are git-ignored and must be removed manually when no longer needed.

Execution additionally requires the dedicated `da-hlx6-migration` AWS role, the R2 read-only credentials, and a DA auth token whose identity is authorized for DA config/image reads and target `media:upload`, `config:read`, and `config:write`. The runner obtains one token from the local `da-auth/src/cli.js token` helper, or uses `DA_CONFIG_TOKEN` if supplied, and shares it across these API calls. No separate target-specific bearer tokens are required. Put the AWS and R2 settings in `.dev.vars`, then run `node bin/migrate.js <source-org/source-site> <target-org/target-site> --refresh-source -x`. It has no delete path and refuses unplanned target objects.

Any stored object under the target site's prefix requires explicit `--overwrite`
for execution, including objects from a prior identical migration. This is
checked before source downloads and again before uploads/writes. `--overwrite`
permits only planned overwrites; unplanned target objects and config conflicts
still block migration. Without `-x`, it makes no remote changes.

### Ignoring folders

Use repeatable `--ignore-folder` options in inventory, full validation or execution:

```bash
node bin/migrate.js --dry-run adobecom/da-events kptdobe/da-events-migrated \
  --ignore-folder /drafts/esp-dev \
  --ignore-folder /drafts/esp-stage
```

Paths are absolute relative to the source site, case-sensitive and literal
(no globs or URL decoding). A trailing slash is optional. Exclusions cover
folder markers, nested files/sidecars, all versions and audit logs associated
with ignored current-file IDs, and version snapshots whose metadata path points
into an ignored folder (including orphan versions). A similarly named sibling
such as `/drafts/esp-dev-other` is not excluded by `/drafts/esp-dev`. The site root
and dot/empty path segments are rejected.

**Cost:** prefix checks are cheap, but DA stores history by document ID rather
than folder. With stored history, live runs HEAD ignored current objects to
resolve IDs, then HEAD remaining versions to check path hints. History already
matched by an ignored ID needs no HEAD or GET. Sites without history need no
extra metadata reads. Large histories can therefore add significant latency and
metadata-request charges, even in inventory mode. Requests use the configured
download concurrency (`--concurrency`, default 24).

Excluded bodies are never downloaded, snapshotted, parsed for images or written.
Local dumps reuse manifest metadata without remote reads; missing required
metadata is an explicit error. Reports list normalized `ignoredFolders`,
excluded keys with `reason: ignored-folder`, and `folderExclusionMetadataReads`.
Source counts and bytes describe only selected objects. Filtered snapshots record
their exclusions and cannot be reused with fewer exclusions; refresh instead.
Target inventory and conflict protections are unchanged, and exclusions never
delete existing source or target objects.

### Project config and images

Project config is read from `https://admin.da.live/config/{source-org}/{da-site}` and rewritten into `editor.da` of the target site's `config.json`, using a property-only `POST` to `https://api.aem.live/{target-org}/sites/{hlx6-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; different existing sheet rows are rejected. Previously migrated configs containing metadata or sheet wrappers are converted only when their rows match the source. Full-validation dry runs only read and report the planned config migration.

The DA auth token is captured without printing it. Supply a helper-issued `DA_CONFIG_TOKEN` in the local environment file to override the local helper. Confirm that the authenticated identity has all required permissions before execution. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The run report includes `projectConfig` status and API URLs, not config contents or credentials.

Image uploads follow the target site's API keep rules. Failed image fetches or
uploads preserve their original URLs and are reported individually as warnings;
successful uploads are rewritten. Progress and reports retain completed write
and image counts if a later operation fails.

## Experimental browser UI

```bash
npm run ui
```

Open the printed loopback-only `http://127.0.0.1:3000` URL; do not expose or proxy
the server. It uses the same private credentials and storage clients as the CLI.
Enter the source organization/site, optionally choose a different destination,
and enter ignored site folders one per line. Site selection and ignored folders
are saved in browser local storage. Tokens, configs, reports and the full-validation
option are not stored there.

**Prepare Migration** authenticates with `da-auth-helper` or `DA_CONFIG_TOKEN`,
loads aggregated site configs, and runs an inventory dry-run. **Full validation**
opts into source downloads and body-dependent checks. The UI never executes
remote writes. **Sign in with DA** starts a fresh browser login; it does not
refresh AWS/KLAM storage credentials. Authentication/config errors and progress
are shown explicitly. One preparation runs at a time; the active job and last
report remain available on reload until the server stops or another preparation
starts. Configs and reports can contain sensitive site settings, so do not share
the UI or leave the server running unnecessarily.
