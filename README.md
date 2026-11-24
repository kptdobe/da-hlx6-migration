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

5. Dump the migrated HLX6 target and compare it with the DA snapshot. Confirm the expected content, versions, audit history, and media before changing the site's source URL.

	```bash
	node bin/dump.js -b hlx6 <org>/<hlx6-site>
	node bin/compare.js analysis/da/<org>/<da-site> analysis/hlx6/<org>/<hlx6-site>
	```

6. Change `content.source.url` to the HLX6 source and leave `content.fixedContentBusId` set to `true`. Verify preview/live content and media, then resume authoring on HLX6. For rollback, restore the DA source URL without removing the flag.

`bin/migrate.js` supports arbitrary source and target organizations/sites. Execution resolves and validates both content bus IDs from live site configs and assumes a migration role scoped to the target. Legacy string-valued `fixedContentBusId` settings remain supported. The runner copies a fresh snapshot; it does not provide live delta synchronization or delete source objects.

## CLI usage
Credentials and runtime settings are loaded from the local, git-ignored `.dev.vars` file; its non-empty values take precedence over shell variables. It holds the R2 read-only token and optional AWS profile/role settings and DA token override. Migration preparation and execution can obtain temporary AWS credentials through browser login; copied AWS keys are not required. Keep the file's mode owner-only (`chmod 600 .dev.vars`).

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
Storage failures identify the operation and exact bucket/key (or listing prefix),
HTTP status, service error code, and available retry/request IDs. The JSON report
also records these fields under `storageError`. An SDK `UnknownError` is not a
root-cause diagnosis: use its HTTP status to distinguish missing objects (404),
access failures (401/403), or throttling/service failures (429/5xx). Errors during
body downloads or gzip decoding retain the same object context. Raw SDK responses,
credential fields, and response bodies are not included in the diagnostic report.
Full validation/execution retains an owner-only source snapshot under `tmp/`,
with bodies, a manifest and a completion marker. Incomplete snapshots cannot be
reused. `--source-dump <directory>` selects a local snapshot; `--refresh-source`
refreshes it from DA. Snapshots and reports contain confidential site data:
they are git-ignored and must be removed manually when no longer needed.

If execution stops after completing its source snapshot, resume without another
download:

```bash
node bin/migrate.js <source-org/source-site> <target-org/target-site> \
  --execute --resume --source-dump tmp/<completed-snapshot>
```

Resume requires a complete snapshot with all bodies and matching completion counts.
It compares the selected live source keys, ETags, stored sizes and modification
times (at HTTP-date second precision) with the snapshot before loading bodies
or writing anything. Changed,
added or missing source objects block resume; use `--refresh-source` instead.
Keep DA edits frozen through verification and cutover. Resume does not bypass
target conflicts or overwrite protection. Full validation and execution obtain
DA authentication before loading or downloading source bodies.

Execution additionally requires the dedicated `da-hlx6-migration` AWS role, the R2 read-only credentials, and a DA auth token whose identity is authorized for DA config/image reads and target `media:upload`, `config:read`, and `config:write`. The runner obtains one token from the local `da-auth/src/cli.js token` helper, or uses `DA_CONFIG_TOKEN` if supplied, and shares it across these API calls. No separate target-specific bearer tokens are required. Put the R2 settings and any optional AWS profile/role settings in `.dev.vars`, then run `node bin/migrate.js <source-org/source-site> <target-org/target-site> --refresh-source -x`. It has no delete path and refuses unplanned target objects.

### AWS / KLAM browser authentication

Migration preparation and execution reuse a cached AWS browser session, or valid
existing AWS credentials. Missing or expired credentials trigger `aws login`.
Sign into KLAM to establish an AWS console session if needed, then select that
operator session in the AWS login browser window. There is no need to copy
access keys or session tokens.

Prerequisites:
- **AWS CLI 2.32.0 or newer** (`aws --version`). Older or missing installations
  produce an explicit upgrade/install error.
- The KLAM operator role must allow AWS local-development sign-in; ask an account
  administrator to grant the AWS-managed `SignInLocalDevelopmentAccess` policy
  or equivalent permissions. This belongs on the operator role, not the scoped
  migration role. See [AWS browser-login setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html).

Browser login uses the dedicated `da-hlx6-migration-login` profile, independently
of `AWS_PROFILE`. This avoids conflicting with copied access keys in `default`
or another existing profile, which remain untouched. Existing credentials can
still be read through the normal AWS credential chain. Before opening login, the
helper saves `us-east-1` as the login profile's region so first-time sign-in does
not prompt for a region in the terminal.
AWS CLI manages the login profile in `~/.aws/config` and
short-lived authentication data in `~/.aws/login/cache`; this is not a
zero-local-cache flow. The helper does not write `~/.aws/credentials` or copy
AWS secrets into `.dev.vars`. Explicit browser sign-in takes precedence over
copied credentials for the running UI session. SDK credential refresh reuses
the browser session until reauthentication is required.

The UI restores usable saved sessions on first load, including after a server
restart, without opening browser login. It checks the AWS providers and validates
credentials with STS; missing or expired sessions require sign-in rather than
opening an unsolicited login window. Successful AWS validation is cached until
the next periodic check or near credential expiry. The UI's **Sign in with
AWS / KLAM** button still explicitly starts a fresh browser login without running
a migration; analysis and validation recheck authentication when needed.
Only authentication status, expiry metadata and actionable errors reach the
browser, never AWS keys or session tokens. Network and storage authorization failures are not
silently treated as expired sessions. AWS and DA sign-in remain separate.
Execution still assumes the existing migration role with the same scope tags;
this feature does not change IAM trust or storage permissions. R2 access still
requires the read-only credentials in `.dev.vars`.

DA's `da-auth-helper` persists the Adobe token and its `expires_at` timestamp in
`~/.aem/da-token.json`. Startup reuses an unexpired token with the helper's
60-second clock-skew margin. Legacy cached tokens without expiry require sign-in.
`DA_CONFIG_TOKEN` takes precedence unless a fresh browser login was explicitly
requested for the running UI session. For an environment token, a JWT `exp` claim
is used when available; opaque tokens show **Expiry unavailable**, never an
invented lifetime. Expiry metadata is not proof of authorization: DA rejection
or revoked site permissions still require corrective action.

Session lifetimes are shown on the sign-in cards and throughout later workflow
steps, with absolute local expiry times, remaining time and warnings for DA tokens
with at most 30 minutes remaining. Status refreshes every 30 seconds when idle and
with progress polling during a run. AWS expiry refers to the current credentials,
not the overall browser-login session: SDK refresh can extend credentials only
while that session remains valid, and its deadline is not provided. Copied AWS
keys without expiry show **Expiry unavailable**; the internal 15-minute
revalidation schedule is not presented as credential expiry.

DA tokens cannot refresh silently, and a running job retains its initial token.
Renew DA sign-in before a long run if the remaining lifetime is insufficient.
Neither expiry display nor AWS refresh guarantees an uninterrupted migration.
The tool adds no separate token store and never puts credentials in browser
storage or reports.

Standalone dump commands continue to use the standard AWS credential chain.
To reuse the browser session with them, select its profile, for example
`AWS_PROFILE=da-hlx6-migration-login node bin/dump.js -b hlx6 <org/site>`.

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
than folder. DA IDs are random UUIDs (or caller-supplied GUIDs), not hashes of
the path; updates and moves retain the stored ID, so generating an ID locally
cannot recover the existing history folder. With stored history, live runs HEAD
ignored non-media current objects to resolve IDs, then HEAD remaining versions
to check path hints. Media, including trashed media, have no DA version history
and need no identity metadata reads. History already matched by an ignored ID
needs no HEAD or GET. Sites without history need no
extra metadata reads. Large histories can therefore add significant latency and
metadata-request charges, even in inventory mode. Requests use the configured
download concurrency (`--concurrency`, default 24).

Excluded bodies are never downloaded, snapshotted, parsed for images or written.
If an ignored current object disappears after listing, its metadata 404 is logged
as skipped, not a blocker. It remains excluded with `metadataStatus: not-found`;
remaining version snapshots are still checked against the ignored folder paths.
Other metadata errors, and missing objects selected for migration, still fail.
Local dumps reuse manifest metadata without remote reads; missing required
metadata is an explicit error. Reports list normalized `ignoredFolders`,
excluded keys with `reason: ignored-folder`, and `folderExclusionMetadataReads`.
Source counts and bytes describe only selected objects. Filtered snapshots record
their exclusions and cannot be reused with fewer exclusions; refresh instead.
Target inventory and conflict protections are unchanged, and exclusions never
delete existing source or target objects.

### Project config and images

Project config is read from `https://admin.da.live/config/{source-org}/{da-site}` and rewritten into `editor.da` of the target site's `config.json`, using a property-only `POST` to `https://api.aem.live/{target-org}/sites/{hlx6-site}/config/editor/da.json`. Top-level properties starting with `:` (including `:properties`) are excluded. Each sheet is replaced by its own `data` array, preserving its name and row values except for same-site DA URL rewrites described below; sheet wrappers (`total`, `limit`, `offset`, `:colWidths`, etc.) are discarded. For example, `{ "data": { "data": [...] }, "alex": { "data": [...] } }` becomes `{ "data": [...], "alex": [...] }` under `editor.da`. Sheets without a data array are rejected. Other target settings are preserved. Missing DA config is skipped; identical target row arrays are resumable; unrelated differences in existing sheet rows are rejected. Previously migrated configs containing metadata, sheet wrappers or legacy URLs are converted only when their rows match the source after URL rewriting. Full-validation dry runs only read and report the planned config migration.

The DA auth token is captured without printing it. Supply a helper-issued `DA_CONFIG_TOKEN` in the local environment file to override the local helper. Confirm that the authenticated identity has all required permissions before execution. Config conflicts are checked before content writes, and the config is written after content migration succeeds. The private run report includes `projectConfig` status, URL rewrites and warnings, not full config contents or authentication headers. References may contain sensitive URL parameters; protect reports like source snapshots.

### Same-site DA URLs

Editor settings and transferred HTML, JSON and SVG (including trash and version
snapshots) rewrite absolute HTTP(S) and protocol-relative URLs on the exact
`admin.da.live` and `content.da.live` hosts when their owner/site matches the
source. The destination owner/site is used, including cross-owner migrations:

| Legacy URL path | Destination path under `https://api.aem.live/{target-org}/sites/{hlx6-site}` |
|---|---|
| `content.da.live/{source-org}/{da-site}/{path}` | `/source/{path}`; extensionless documents gain `.html`, directories gain `index.html` |
| `admin.da.live/source/{source-org}/{da-site}/{path}` | `/source/{path}` |
| `admin.da.live/list/{source-org}/{da-site}/{folder}` | `/source/{folder}/` |
| `admin.da.live/config/{source-org}/{da-site}` | `/config/editor/da.json` |

Queries, fragments and encoded paths are retained. References to other sites or
owners, org-level URLs, published `aem.page`/`aem.live` URLs and binary media stay
unchanged. Unmappable same-site admin routes (such as UUID versions or copy/move)
remain unchanged with `unrewritten-da-urls` / `unrewritten-da-config-urls` warnings;
these still require client changes. A URL rewrite does not adapt request bodies
or response formats.

Full-validation dry runs report planned content `urlRewrites` and
`projectConfig.urlRewrites`; inventory-only dry runs skip URL discovery.
Execution reports content rewrites after image handling. Source snapshots,
original-body ownership hashes, unchanged JSON formatting and numeric literals
are preserved; only affected JSON string tokens are re-encoded.
Invalid JSON string escapes fail full validation with the source key rather than
writing a corrupted rewrite.

Image uploads follow the target site's API keep rules. Failed image fetches or
uploads retain their references, with same-site DA URLs rewritten to the source
API, and are reported individually as warnings; successful uploads retain the
existing `./media_...` rewrite. Images are fetched using original URLs before
general DA URL rewriting. Progress and reports retain completed write
and image counts if a later operation fails.

### Audit history

DA's active `.da-versions/{id}/audit.txt` and archived `audit-*.txt` files
migrate to gzip-compressed JSONL under `.versions/{doc-id}/audit/`.
The active file becomes `audit.jsonl`; archive names use their first valid
activity's zero-padded timestamp and deterministic ID. Archive boundaries are
preserved, including histories without a current document.

The conversion targets the storage schema proposed in
[adobe/helix-api-service#556](https://github.com/adobe/helix-api-service/pull/556)
and [adobe/helix-audit-logger#595](https://github.com/adobe/helix-audit-logger/pull/595).
Confirm compatible reader/logger changes are deployed before cutover.
Edit sessions remain edits, not fabricated versions. Original timestamps,
all actor emails (lowercased), paths and labels are retained; saved-version
events link to migrated version IDs. Missing or unsupported snapshots produce
warnings and retain the event without a snapshot link.

Malformed records do not block migration: valid records in the same file still
migrate. Each skip is logged with its source key, 1-based line number and reason.
The owner-only report's `malformed-audit-records` warning also contains the raw
line for further analysis; the source snapshot retains the original files.
Treat these diagnostics as confidential site data. Unavailable source objects
still fail normally. Dump/compare reports count active and archived audit
records on both backends; subtract reported skipped records from DA totals.

## Experimental browser UI

```bash
npm run ui
```

Open the printed loopback-only `http://127.0.0.1:3000` URL; do not expose or proxy
the server. It uses the same authentication helper and storage clients as the migration CLI.
The guided workspace has five steps, with only the current step on screen:

1. **Sign in** to DA / Adobe and AWS / KLAM. Both accounts must be connected
   before starting analysis. Valid saved sessions are restored automatically.
   Each sign-in button explicitly starts a fresh browser sign-in. Review the
   displayed session lifetimes before a long run.
2. **Select a site** using the source organization and site / repository name.
   Optionally choose a different destination and enter ignored folders, one per line.
   The target site configuration must already exist. Create it manually before
   starting analysis; this tool does not create site configurations. A target
   configuration 404 stops preparation with this instruction. After creating it,
   run analysis again.
3. **First-pass analysis** loads aggregated site configurations and runs the
   listing-based inventory and path checks. It does not download source bodies;
   folder exclusions may require metadata requests. Review blockers, warnings,
   destination occupancy and content-bus preservation before continuing.
   This first pass does not establish migration readiness.
4. **Full dry run** requires an explicit **Start full dry run** action. It downloads
   selected source content into a private local snapshot, builds the migration
   plan and checks destination ownership, project configuration and image
   candidates. Large sites can take a long time and use substantial local disk.
   Live progress shows the current operation's counts, not a guessed overall percentage.
5. **Review report** summarizes planned object actions, image candidates,
   configuration changes, blockers and warnings. Inventory, configuration and
   JSON details remain available without cluttering the main view.

The UI never executes remote writes, uploads images or changes site configuration.
Running the content migration and switching the content source to HLX6 are future
steps, not enabled actions. Resolve blockers and review warnings before any real
migration; a dry run neither freezes the source nor authorizes cutover.

Completed steps can be revisited when idle. Changing site selection or exclusions
invalidates the displayed analysis. Site selection and ignored folders are saved
in browser local storage; tokens, configurations and reports are not.
One preparation runs at a time. Reloading reconnects to an active job or the latest
matching report until the server stops or another preparation starts. Full
validation retains the matching first-pass summary for review, including after a
failed dry run. Lost connections require reconnecting before another action.
Snapshots and JSON reports remain on disk and must be removed manually when no
longer needed. Configurations, snapshots and reports can contain confidential site
data: do not share the UI or leave the server running unnecessarily.
