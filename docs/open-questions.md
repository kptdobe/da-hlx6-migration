# Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| 1 | Prod `HELIX_BUCKET_NAMES`: is it really `helix-source-bus` / `helix-media-bus`? | | open |
| 2 | AWS credentials / role for read + write on the source and media buses | | open |
| 3 | Original timestamps: hlx6 uses S3 `LastModified` for the doc and the version date. Accept, or add a metadata override (e.g. `x-original-date`) honored by the API and da-live? | | open |
| 4 | da audit-only entries (edits without a snapshot): drop, keep as a sidecar, or synthesize? | | open |
| 5 | Versions of hard-deleted da docs: migrate into `.trash`, or drop? | | open |
| 6 | Extensions unsupported by hlx6: drop and report, or extend `CONTENT_TYPES`? | | open |
| 7 | Comments (`.da/comments`): where do they live for hlx6 sites? | | open |
| 8 | Org/site config and ACL migration (KV `DA_CONFIG` → helix config): in scope? | | open |
| 9 | Path sanitization collisions: policy (suffix, fail, or report)? | | open |
| 10 | Media interning: reuse `@adobe/helix-mediahandler` directly against `helix-media-bus`? | | open |
