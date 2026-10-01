# Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| 1 | Prod `HELIX_BUCKET_NAMES`: is it really `helix-source-bus` / `helix-media-bus`? | | open |
| 2 | AWS credentials / role for read + write on the source and media buses | | open |
| 3 | Original dates: hlx6 reads S3 `LastModified` (not settable) for the doc, the listing and the version date. Migration preserves order (seeded ULIDs) and writes `last-modified` / `version-date` metadata. Requires an hlx6 change to honor them ([04 §1](04-migration-rules.md#1-dates-why-they-differ-and-what-we-can-do)) | | **proposal for review** |
| 4 | da audit-only entries (edits without a snapshot): drop from the UI and archive the raw `audit*.txt` with the migration manifest (R8)? | | **proposal for review** |
| 5 | Versions of deleted da docs: migrated as orphan versions, same as hlx6 behaviour (R7) | | resolved |
| 6 | Extensions unsupported by hlx6: drop and report, or extend `CONTENT_TYPES`? | | open |
| 7 | Comments (`.da/comments/{docId}/*.json`) are da-only; da-live disables them on hlx6 (no `x-da-id`). Product decision: add comments support to hlx6 (expose `doc-id`, define the store), then migrate re-keyed by `doc-id`; or drop them | | **deferred**: not migrated for now. Any project with `.da/comments/` objects must be flagged before migration (see [04](04-migration-rules.md#5-pre-flight-checks)) |
| 8 | Org/site config and ACL migration (KV `DA_CONFIG` → helix config): in scope? | | open |
| 9 | Path sanitization collisions: policy (suffix, fail, or report)? | | open |
| 10 | Media interning: reuse `@adobe/helix-mediahandler` directly against `helix-media-bus`? | | open |
| 11 | hlx6 accepts direct writes into the reserved `.trash/`, producing trash entries without `doc-path` or a delete version: [adobe/helix-api-service#456](https://github.com/adobe/helix-api-service/issues/456) | | reported |
