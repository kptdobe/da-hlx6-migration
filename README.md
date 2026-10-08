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

3. Run `node bin/migrate.js <source-org/source-site> <target-org/target-site>` and review its dry-run report. Source and target may belong to different organizations. Resolve blockers and target conflicts before execution.

4. Freeze DA edits, then execute with a fresh source snapshot. Keep the freeze in place through verification and cutover. The sample runner requires `--refresh-source -x`; a production runner must likewise migrate the final frozen snapshot.

5. Dump the migrated HLX6 target and compare it with the DA snapshot. Confirm the expected content, versions, and media before changing the site's source URL.

	```bash
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	node bin/compare.js analysis/da/<org>/<da-site> analysis/hlx6/<org>/<hlx6-site>
	```

6. Change `content.source.url` to the HLX6 source and leave `content.fixedContentBusId` set to the recorded DA ID. Verify preview/live content and media, then resume authoring on HLX6. For rollback, restore the DA source URL without removing the fixed ID.

`bin/migrate.js` supports generic read-only dry-runs. Execution remains restricted to the approved sample migration; production writes still require separately reviewed bus IDs and IAM scope. The runner does not provide live delta synchronization or delete source objects.

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

All CLI scripts print timestamped startup source/target summaries and stage progress.
Summaries include org, repo/site, storage or local dump location, and content bus IDs when known.
Unknown IDs are explicitly marked rather than inferred; dump/preflight/compare do not require
additional config access just to resolve them. Migration validates and prints the target bus ID
read from its site config. Listing reports pages and object counts; remote reads and local dump
reads/writes report completed/total objects (downloads also report bytes). Target conflict checks,
image uploads, content writes, and project config reads/writes report their stages.
Object progress is throttled to once per five seconds, with immediate stage changes and completion.
While waiting on asynchronous operations, a heartbeat repeats the current activity every 15 seconds.
Credentials, tokens, config contents, and object bodies are not printed.

Inventory a live DA source and an HLX6 target, including cross-org migrations:

```bash
node bin/migrate.js <source-org/source-site> <target-org/target-site>
node bin/migrate.js --dry-run adobecom/da-events kptdobe/da-events-migrated
```

Dry-run is the default; `--dry-run` is optional and cannot be combined with `-x`.
It uses listings only for site content: no per-file HEAD or GET requests, no source
body downloads, and no DA token or project-config API requests. Small site configs
are still read to validate the target and resolve summary bus IDs. Reports include
each source and target key's stored byte size, object counts, and total stored bytes.
`sourceSummary` and `targetSummary` separately report current content (documents,
sheets, media, and folder markers), version history (`.da-versions/` on DA and
`.versions/` on HLX6, including audit logs), trash, and internal/sidecar objects.
Each category has its own object count and stored-byte total, and the CLI prints
the same breakdown. Category totals add up to the complete site inventory.
Sizes are storage sizes (including compression), not estimated migration output sizes.
Source path checks run from the listing. Metadata/body-dependent checks are explicitly
listed under `skippedChecks`: orphan version detection, migration planning, destination
ownership/hash matching, external images, and project-config comparison. A successful
inventory does not establish migration readiness or confirm existing content matches.

To download source objects and perform the previous full dry-run validation, opt in:

```bash
node bin/migrate.js --dry-run --full-validation source-org/source-site target-org/target-site
```

Full validation downloads source content into process memory and runs body-dependent
planning and conflict checks; it still performs no uploads or remote writes.
The target must already have the expected HLX6 source URL and a valid content bus
ID. Source and target summaries print resolved bus IDs before scanning; an
inaccessible source config is explicitly reported as unknown. Use a local source
dump instead of a live scan with (inventory reads only its manifest, not body files):

```bash
node bin/migrate.js --source-dump analysis/da/source-org/source-site source-org/source-site target-org/target-site
```

Dry-run storage clients permit only list/head/get; API calls permit only GET/HEAD.
No write role is assumed and no content, media, or configuration is written remotely.
With `--full-validation`, `--overwrite` only plans overwrites without `-x`;
unplanned target objects and project-config conflicts still block that validation.
Inventory does not plan overwrites or check target ownership. Reports are
timestamped, owner-only files under `analysis/` and existing reports are never
overwritten; `-o` selects a new output file. Reports include blockers and return
a nonzero exit status on failure. Source bodies are only read during full validation
or execution. Those bodies are held in memory rather than saved to disk, unless
refreshing an explicitly selected source dump; that refresh requires full validation
or execution. Reports contain
confidential site paths and image URLs. Valid AWS and read-only R2 credentials
are required; DA authentication uses the local `da-auth` helper.

Source folder and file names are reused exactly, including case, extension case,
spaces, accents, percent escapes, dots, underscores, and punctuation. There is no
normalization or URL decoding. `renamed-paths` remains in the report for
compatibility with count zero. Required backend layouts still apply: folder
markers such as `.drafts.props` become `.drafts/.props`, versions use `.versions/`,
and trash keeps its namespace. Unsupported extensions and sidecar exclusions
are unchanged. Unusual names still require separate target read/authoring API
compatibility validation. Previously renamed target objects are not automatically
renamed or deleted; unplanned-object protection remains in force.

The `.da` folder has no special migration treatment. Supported files (including
`config.json`, arbitrary JSON, and comment JSON) and folder markers follow the
ordinary content rules and preserve their `.da` path. Comment JSON is copied as
data; this does not reattach comments to migrated document IDs or enable the HLX6
comment UI. Existing local dumps are reclassified when planning so obsolete
`da-internal` or `comment` labels cannot skip these files.

All site scans use the `da-magic` shard generator copied and adapted into
`src/sharding.js`, with no dependency on the sibling project. Character prefixes
and 256 hex version prefixes define disjoint S3 key ranges using `StartAfter`.
Ranges include gaps, boundary keys, other `.da` content, and Unicode names rather
than silently skipping keys outside the known character set. Listing defaults
to 8 concurrent workers. Full validation and execution download with 24 workers and
uses SDK adaptive retries, which rate-limit requests when throttling occurs.
Use `--listing-concurrency` (1..32) and `--concurrency` (1..64); do not increase
them blindly against production. Progress includes aggregate object counts,
completed shards, pages, downloaded bytes, and heartbeats. A dry-run remains a
point-in-time plan, not an atomic snapshot or authorization to execute.

For backwards compatibility, omitting source/target arguments selects `kptdobe/sample-content-da` to `kptdobe/sample-content-hlx6-migrated`; dry-runs inventory the live sites unless `--source-dump` is selected. Execution automatically performs full validation and only this approved pair can use `-x`; generic and cross-org execution is rejected before loading credentials. Execution additionally requires the dedicated `da-hlx6-migration` AWS role, read-only R2 credentials, and a DA auth token authorized for DA config/image reads and target `media:upload`, `config:read`, and `config:write`. The runner uses `DA_CONFIG_TOKEN` if supplied, otherwise captures the token from `/Users/acapt/work/dev/helix/da/da-auth/src/cli.js token` without printing it. Put the AWS and R2 settings in `.dev.vars`, then run `node bin/migrate.js --refresh-source -x` for the approved sample only. With no site arguments, execution refreshes its existing sample dump. It has no delete path and refuses unplanned target objects.

To rerun and overwrite all planned sample content, use `node bin/migrate.js --refresh-source --overwrite -x`. Without `-x`, this only plans overwrites. Execution remains pinned to the sample pair, unplanned target objects still block migration, and config conflict protection is unchanged.

Project config is read from `https://admin.da.live/config/{source-org}/{source-site}` and planned for `editor.da` of the target site's `config.json`. Execution uses a property-only `POST` to `https://api.aem.live/{target-org}/sites/{target-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; different existing sheet rows are rejected. Previously migrated configs containing metadata or sheet wrappers are converted only when their rows match the source. Dry runs only read and report the planned config migration.

The DA auth token is captured without printing it. The runner invokes the local DA authentication helper, or accepts a helper-issued `DA_CONFIG_TOKEN` in the local environment file. Confirm that the authenticated identity has all required permissions before execution. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The run report includes `projectConfig` status and API URLs, not config contents or credentials.
