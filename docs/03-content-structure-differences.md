# 03 - Content structure differences (empirical)

Source projects: `kptdobe/sample-content-da` (R2 `aem-content`) and `kptdobe/sample-content-hlx6` (S3 `helix-source-bus`).

## Method
1. List both prefixes at the storage level. Capture key, size, ETag, content-type, content-encoding, all user metadata and LastModified.
2. Download everything into `analysis/{da,hlx6}/` (git-ignored). Gunzip hlx6 bodies.
3. Normalize volatile values: UUID, ULID, epoch/ISO timestamps, ETags and emails become placeholders.
4. Map keys using the rules in [02](02-storage-model.md), then diff:
   - key sets: unmatched on either side
   - bodies: byte-equal, or equal after HTML/JSON normalization
   - metadata key sets per object type
   - versions per document: count, shape and metadata keys (not values and not order)
5. Generate the findings table below from the tool output, then review it by hand.

## Checks derived from 02 (each one confirmed or refuted)
- [ ] Folder markers: `x.props` (da) vs `x/.props` (hlx6)
- [ ] hlx6 bodies are gzip; `uncompressed-length` equals the da size for identical content
- [ ] HTML bodies are equal (are there wrapper or attribute differences?)
- [ ] Image URLs in HTML: `content.da.live/...` vs `./media_...` (+ media bus objects)
- [ ] Sheets: JSON shape identical (single, multi-sheet, `:private`)
- [ ] Versions: number of da `.da-versions/{id}/*.html` vs hlx6 `.versions/{id}/*`
- [ ] Audit lines in da with no hlx6 counterpart
- [ ] Deleted docs: da hard delete vs hlx6 `.trash/` + version
- [ ] Moved/renamed docs: id/doc-id preserved?
- [ ] Names with uppercase, space, `_`, unicode: resulting keys on each side
- [ ] Comments (`.da/comments/...`) location on hlx6

## Edge cases the samples must contain
- [ ] nested folders; names with spaces, unicode, `_` and uppercase letters
- [ ] an empty folder
- [ ] a document with several versions, including named versions and a restored one
- [ ] a sheet with multiple tabs, and a sheet with a `:private` tab
- [ ] an image pasted in a doc, a PDF, an SVG, an MP4 and a large binary (> 4.5 MB)
- [ ] an unsupported extension (e.g. `.txt`, `.xml`)
- [ ] a moved doc, a renamed doc, a deleted doc and a deleted folder
- [ ] a document with comments

## Findings
_To be generated in Phase 3._

| # | Dimension | da | hlx6 | Transformation | Lossy? |
|---|---|---|---|---|---|
| 1 | Key / path layout | | | | |
| 2 | Documents (.html) | | | | |
| 3 | Sheets (.json) | | | | |
| 4 | Media / binaries | | | | |
| 5 | Folders | | | | |
| 6 | Object metadata | | | | |
| 7 | Versions | | | | |
| 8 | Audit log | | | | |
| 9 | Object identity / IDs | | | | |
| 10 | Delete / move / trash | | | | |
| 11 | Comments | | | | |
| 12 | Config / ACL | | | | |
