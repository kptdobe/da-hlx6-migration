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

`bin/migrate.js` supports dry-runs and execution for arbitrary source and target organizations/sites. Execution resolves and validates both content bus IDs from their live site configs and assumes a migration role scoped to the target. The runner does not provide live delta synchronization or delete source objects.

## Experimental browser UI

```bash
npm run ui
# Optional:
npm run ui -- --port 3001 --env-file .dev.vars
```

Open the printed `http://127.0.0.1:3000` URL. The server is loopback-only; do not
expose or proxy it to a network. It uses the same private `.dev.vars` credentials
and AWS read access as the CLI. Stop it with Ctrl+C.

Enter an organization and site. The destination defaults to the same site;
select **Use a different destination** for another organization/site.
Source/destination fields and the different-destination toggle are saved as you
edit them in browser local storage and restored on reload, including unfinished
selections. A saved selection takes precedence over the last completed run;
an active preparation still shows its actual selection. Only site selection is
stored, not tokens, configs, reports, or the full-validation option. Storage is
specific to the browser origin (including the local server port). If browser
storage cannot be read or written, the UI shows a warning.
**Prepare Migration** authenticates using the pinned `da-auth-helper` dependency
(cached DA login or a browser sign-in), or `DA_CONFIG_TOKEN` from `.dev.vars` /
the environment. Tokens stay on the server and are not returned to the UI.
The authenticated identity needs `config:read` for each selected site.
You can also use **Sign in with DA** before preparing or after an authentication
failure. It starts a fresh browser login, replacing the helper's cached login
and ignoring any `DA_CONFIG_TOKEN` override for subsequent preparations in this
server session. Authentication status and login errors are shown in the UI.
The helper uses localhost port 9898 for its callback; keep that port available.
Signing in does not load configs or run a dry-run. A rejected (401) config
request explicitly prompts you to sign in again; a 403 can also mean missing
site permissions rather than a missing login.

Preparation reads
`https://api.aem.live/{org}/sites/{site}/config.json?aggregated=true`, once for
identical source/destination sites and separately otherwise. The UI shows
`content`, `access`, and `editor`, plus an initially collapsed whole-config view.
Highlighted migration-state cards show whether the source has
`content.fixedContentBusId` enabled (or a legacy pinned bus ID), and explain why
it should be set before switching the content source URL. They also show whether
the target prefix exists in `helix-source-bus` and, if so, whether it contains
files or only folder markers. Existence means at least one stored object, not
merely a site config. File counts exclude `/.props` folder metadata and
slash-terminated directory markers, but include stored versions, trash, and
sidecars. Unknown or failed inventory is never presented as an empty target.
It then runs the existing read-only migration dry-run and shows source/target
object counts, stored bytes, inventory categories, bus IDs, blockers, warnings,
and skipped checks. Expand the whole report for details. The CLI's usual private
JSON report is retained in `analysis/`; config responses are held in server
memory only. Configs and reports can contain sensitive site settings: do not
share the UI or leave the server running unnecessarily.

The default is **listing-only inventory**, not a migration-readiness guarantee.
Select **Full validation** to download and retain a private source snapshot and
perform the CLI's body-dependent checks, image planning, and project-config
comparison. Both modes prohibit remote writes; the UI has no execution or
overwrite control. The CLI still resolves migration bus IDs from config-bus,
while the UI config panels show the aggregated API view.

One preparation runs at a time. Progress, config results, and the last report
remain available on reload until the server stops or another preparation starts.
A sticky activity banner shows a spinner while sign-in, config loading, or the
dry-run is running, with the current phase and available progress counts. It
distinguishes finished, blocked, failed, and disconnected states; a connection
failure does not imply that server-side work has stopped.
Expired AWS storage credentials are reported separately from DA authentication,
with instructions to refresh the local AWS/KLAM session for the selected AWS
profile or environment credentials, then retry preparation. **Sign in with DA**
does not renew AWS credentials.
Each new preparation rereads shared AWS credential/config files, so locally
refreshed profile credentials take effect without restarting the UI server.
Credentials exported in the server's environment must instead be updated in
that environment and the server restarted; edits in another terminal cannot
change an already running process's environment.
Authentication/config errors are shown explicitly; successfully loaded configs
remain visible if later inventory or validation fails.

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
The final automatic output summarizes elapsed seconds, new/overwritten writes,
image uploads/errors, project-config status, warnings/blockers, and the retained
source location as `./tmp/...`. Success, blocked execution, and dry-runs have
distinct headings. Completed writes and image uploads are tracked as they happen
so later failures still report partial work.

Inventory a live DA source and an HLX6 target, including cross-org migrations:

```bash
node bin/migrate.js <source-org/source-site> <target-org/target-site>
node bin/migrate.js --dry-run adobecom/da-events kptdobe/da-events-migrated
```

Dry-run is the default; `--dry-run` is optional and cannot be combined with `-x`.
It uses listings only for site content: no per-file HEAD or GET requests, no source
body downloads, and no DA token or project-config API requests. Small site configs
are still read to resolve summary bus IDs. The target's source URL does not gate
inventory, full validation, or execution; it can still point to DA before cutover.
Missing or invalid target bus IDs are marked unknown in dry-runs; execution still
requires valid effective source and target bus IDs for the scoped role and media.
Any object under `helix-source-bus/<target-org>/<target-site>/` means the target
exists, regardless of config or content bus ID. Dry-runs log and report a
`target-exists` warning. Execution blocks before source downloads or assuming a
write role unless `--overwrite` is supplied, even for identical prior migration
objects. The runner checks again before uploads/writes. `--overwrite` permits
planned overwrites only; unplanned objects and project-config conflicts still
block. Reports include
each source and target key's stored byte size, object counts, and total stored bytes.
`sourceSummary` and `targetSummary` separately report current content (documents,
sheets, media, and folder markers), version history (`.da-versions/` on DA and
`.versions/` on HLX6, including audit logs), trash, and internal/sidecar objects.
Each category has its own object count and stored-byte total, and the CLI prints
the same breakdown. Category totals add up to the complete site inventory.
Sizes are storage sizes (including compression), not estimated migration output sizes.
Source path checks run from the listing. Metadata/body-dependent checks are explicitly
listed under `skippedChecks`: orphan version detection, migration planning, destination
ownership/hash matching, source-site image uploads, and project-config comparison. A successful
inventory does not establish migration readiness or confirm existing content matches.

To download source objects and perform the previous full dry-run validation, opt in:

```bash
node bin/migrate.js --dry-run --full-validation source-org/source-site target-org/target-site
```

Full validation downloads source content and retains a private local snapshot under
`./tmp/da-migration-{source-org}-{source-site}-{unique-id}/` in the directory
where the command is run. The snapshot is excluded from Git. It is saved
while running body-dependent planning and conflict checks; it still performs no
uploads or remote writes. Execution retains the same kind of snapshot. The CLI
prints the directory before downloading and records it as `sourceDump` in the
report. Files are saved as each download completes, under `files/` with their
original paths; `manifest.json` maps keys to local files. Folder-like objects that
also have children, unsafe local paths, and filesystem naming collisions use
`objects/` fallback files identified by the manifest. Bodies are decompressed
when the source uses gzip, matching the planner's input.

Snapshots include current content, versions, audit logs, and trash. They are
retained after success or failure; `snapshot.json` and `sourceSnapshotComplete`
indicate whether every object was downloaded. Incomplete snapshots cannot be
reused for planning. Directories are owner-only (0700), files are 0600. These
snapshots contain confidential production content: move them somewhere durable
if needed and remove them when no longer needed; `./tmp/` snapshots are not
automatically removed. Image bytes fetched separately for media uploads are not
part of this source snapshot.

The planner still consumes buffers in memory. Persistence adds inspection and
reuse, not a streaming or reduced-memory implementation; the previous memory-only
behavior was an implementation choice, not a measured performance optimization.
The target does not need an HLX6 source URL before migration. Execution requires
a valid content bus ID. Source and target summaries print resolved bus IDs before scanning; an
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
or execution. They are retained in a private temp snapshot and also used as
in-memory buffers by the planner. Refreshing an explicitly selected source dump
still requires full validation or execution and saves an additional local copy.
Reports contain
confidential site paths and image URLs. Valid AWS and read-only R2 credentials
are required; DA authentication uses the local `da-auth` helper.

Source folder and file names are reused exactly, including case, extension case,
spaces, accents, percent escapes, dots, underscores, and punctuation. There is no
normalization or URL decoding. `renamed-paths` remains in the report for
compatibility with count zero. Required backend layouts still apply: folder
markers such as `.drafts.props` become `.drafts/.props`, versions use `.versions/`,
and trash keeps its namespace. Unsupported files and paths are warnings, not
blockers: they are listed in `unsupported-extensions`, excluded from migration,
and logged individually as `SKIPPED`. Full-validation/execution reports also
include every source key in `excluded` with `reason: unsupported-extension`.
This covers current content, trash, and version snapshots; supported objects
continue migrating. File property sidecars remain excluded. Unusual names still require separate target read/authoring API
compatibility validation. Previously renamed target objects are not automatically
renamed or deleted; unplanned-object protection remains in force.

Image selection follows api-service HTML POST keep rules for the target site:
keep `https://main--{target-site}--{target-org}.aem.page/`, the corresponding
`.aem.live/`, `./media_...`, and HTTPS `/adobe/dynamicmedia/deliver/` URLs on any
host. Other image references are upload candidates, including
`https://content.da.live/{source-org}/{source-site}/...`, source-site AEM URLs,
and third-party URLs. Candidates in `srcset` are processed individually.
DA authentication is sent only to the exact `https://content.da.live` origin.
Successfully uploaded images are rewritten to target-relative media paths.
If an individual fetch or upload fails, keep its original URL and continue;
`imageErrors` records the URL, error, source-page keys, and `kept-original-url`
action, also listed under `image-upload-errors` warnings. This fallback differs
from api-service POST, which rejects failed image interning. Missing media API
credentials remain a fatal setup error. `imageUrls` lists attempted candidates;
`uploadedImageUrls` lists successful uploads. Inventory mode does not fetch images.

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

For backwards compatibility, omitting source/target arguments selects `kptdobe/sample-content-da` to `kptdobe/sample-content-hlx6-migrated`; this is a default, not an execution allowlist. Dry-runs inventory the live sites unless `--source-dump` is selected. Execution automatically performs full validation and requires `--refresh-source`, valid read-only R2 credentials, readable source/target site configs, and a scoped AWS migration role. When the source has `content.fixedContentBusId: true`, its `content.contentBusId` is used for both migration scopes. Otherwise each site's bus ID is resolved separately; legacy nonempty string-valued fixed IDs remain supported. Both IDs are validated before constructing the write scope. Bootstrap config reads use a read-only client with the operator credentials. A missing source config is fatal for execution, while an inventory may report its bus ID as unknown.

```bash
node bin/migrate.js --execute --refresh-source source-org/source-site target-org/target-site
# Optional: select a separately provisioned scoped role
node bin/migrate.js --execute --refresh-source --role-arn arn:aws:iam::123456789012:role/migration source-org/source-site target-org/target-site
```

Role selection uses `--role-arn`, then `MIGRATION_ROLE_ARN`, then the shared migration role. The role must trust the operator and accept all six session tags, including `da-org` for the source organization and `org` for the target. **An account administrator must update the deployed trust and role policies from `infra/aws/` before using this version; editing the local templates does not change AWS.** Existing sample-only trust policies will reject generic execution and the new tag. Unsupported content is reported and skipped; duplicate target paths, unplanned target objects, and conflicting project configs still block execution. `--overwrite` only rewrites planned objects. Production source edits must stay frozen through execution and verification.

The DA token must authorize source config/image reads and target `media:upload`, `config:read`, and `config:write`. The runner uses `DA_CONFIG_TOKEN` if supplied, otherwise captures it from `/Users/acapt/work/dev/helix/da/da-auth/src/cli.js token` without printing it. With no site arguments, execution refreshes its existing sample dump. There is no delete path.

To rerun and overwrite all planned sample content, use `node bin/migrate.js --refresh-source --overwrite -x`. For any other pair, also provide the source and target arguments. Without `-x`, `--overwrite` only plans overwrites during full validation. Unplanned target objects still block migration, and config conflict protection is unchanged.

Project config is read from `https://admin.da.live/config/{source-org}/{source-site}` and planned for `editor.da` of the target site's `config.json`. Execution uses a property-only `POST` to `https://api.aem.live/{target-org}/sites/{target-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; different existing sheet rows are rejected. Previously migrated configs containing metadata or sheet wrappers are converted only when their rows match the source. Dry runs only read and report the planned config migration.

The DA auth token is captured without printing it. The runner invokes the local DA authentication helper, or accepts a helper-issued `DA_CONFIG_TOKEN` in the local environment file. Confirm that the authenticated identity has all required permissions before execution. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The run report includes `projectConfig` status and API URLs, not config contents or credentials.
