# da → hlx6 migration: open questions

Context: DA sites are being moved from the **da** backend (da-admin, Cloudflare R2) to the **hlx6** backend (helix-api-service, AWS S3). The migration copies content, versions and images directly at the storage level, because sites can contain millions of objects.

We analysed the code of both backends and compared three test sites:
- `sample-content-da`: on da
- `sample-content-hlx6`: the same content, created by hand on hlx6
- `sample-content-hlx6-migrated`: the empty target of the migration

Details: [02 storage model](02-storage-model.md), [03 differences](03-content-structure-differences.md), [04 migration rules](04-migration-rules.md).

Each question below states the problem, why it matters, and the options. **Rec.** marks the option we propose; it is open for discussion.

## Summary

| # | Topic | Blocks the migration? | Needs a decision from | Status |
|---|---|---|---|---|
| 1 | [Site cutover: the content bus id changes](#1-site-cutover-the-content-bus-id-changes) | **yes** | helix team | open |
| 2 | [Original dates are lost](#2-original-dates-are-lost) | no (data kept, not displayed) | helix team, product | open |
| 3 | [Edit history without a saved version](#3-edit-history-without-a-saved-version) | no | product | open |
| 4 | [Images that cannot be uploaded](#4-images-that-cannot-be-uploaded) | per site | product | open |
| 5 | [Comments](#5-comments) | per site | product | deferred |
| 6 | [File types hlx6 does not accept](#6-file-types-hlx6-does-not-accept) | per site | product, helix team | open |
| 7 | [File names that collide after renaming](#7-file-names-that-collide-after-renaming) | per site | product | open |
| 8 | [Site config and permissions](#8-site-config-and-permissions) | **yes** | helix team | open |
| 9 | [Access for the migration](#9-access-for-the-migration) | **yes** | account admins | proposal ready |
| 10 | [hlx6 accepts writes into `.trash/`](#10-hlx6-accepts-writes-into-trash) | no | helix team | reported |

"Per site": blocks only the sites where the case occurs. The pre-flight check (`bin/preflight.js`) detects and counts these before anything is written.

---

## 1. Site cutover: the content bus id changes

**Problem.** Every site has a `contentBusId`. It names the folder that holds the site's **images** (`helix-media-bus/{id}/`) and its **preview and live content** (`helix-content-bus/{id}/`).

The id is not chosen; it is calculated from the content source URL each time the site config is saved:

```
contentBusId = sha256(content.source.url)[0..59]
```

This is `updateContentSource()` in `@adobe/helix-config-storage` (3.6.0), called on every config `create()` and `update()`. A stored value that doesn't match the URL is overwritten.

Migrating site `abc` to hlx6 means changing its content source URL, so the id changes even though the site name stays the same:

| | content source URL | contentBusId |
|---|---|---|
| before | `https://content.da.live/{org}/abc` | X |
| after | `https://api.aem.live/{org}/sites/abc/source` | Y |

Confirmed on the test sites: `sample-content-da` → `cdb7c31a…`, `sample-content-hlx6-migrated` → `8a228067…`, both matching the formula.

**Why it matters.** When the config switches, the site starts reading from Y, which is empty:
- **The live site shows nothing**, because no page is previewed or published under Y.
- **Images are missing**: the ones previewed on da stay under X.
- The CDN cache for X is purged on the config change (`AdminConfigStore.purge`).

Re-saving the migrated documents is not enough; the preview and live state must exist under Y too.

**Options**

| | Approach | Pros | Cons |
|---|---|---|---|
| A | Switch, then preview and publish every page again | No new tooling | Site is down or incomplete during the bulk publish (hours for large sites); republishes pages that were intentionally left unpublished or only previewed, unless we replay the exact state |
| B | Before the switch, copy `X/preview` and `X/live` to `Y/` (content bus and media bus) | No visible change for visitors; exact preview and live state kept | The migration must write to the content bus (new permission); we must check that nothing else in the content bus depends on the id (indexes, sitemaps, redirects, snapshots); copies must be redone for pages changed before the switch |
| C | Let a site keep its id when its source changes (hlx6 change: e.g. an explicit `contentBusId` that `updateContentSource` does not overwrite, or an admin-only "upgrade" operation) | Nothing to copy for preview, live or previewed images; no outage | Changes a core invariant (id = hash of the source); every consumer of the id must be checked; needs helix team work |

**Rec.** C if the helix team accepts it: it is the only option with no outage and no bulk copy. Otherwise B.

Images are handled in either case: with C the da images are already in place; with B they are copied with the rest.

**Question for the helix team:** is there already a planned "upgrade" path for a da site to hlx6 (da-live detects it via the `x-api-upgrade-available` header)? What does it do with the content bus id?

---

## 2. Original dates are lost

**Problem.** hlx6 does not store dates in metadata. It shows the S3 `LastModified` value, which S3 sets at write time and no client can change. Every migrated document and version would show the **migration date**.

| Date shown in da.live | hlx6 reads it from | Can the migration set it? |
|---|---|---|
| Document "last modified" | S3 `LastModified` | no |
| Folder listing dates | S3 `LastModified` (listing) | no |
| Version date | S3 `LastModified` of the version | no |
| Version author, comment, "doc last modified" | metadata | yes |
| Version order | version id, sortable by time | yes: ids are generated from the original time |

**Why it matters.** Authors rely on the history to know what changed when, and every page would look edited on the same day.

**Options**

| | Approach | Pros | Cons |
|---|---|---|---|
| A | Accept it | No work | History loses its dates; confusing for authors |
| B | hlx6 reads an optional date from metadata (`last-modified` on documents, `version-date` on versions) and falls back to `LastModified` | Small API change; the migration already writes these values, so no re-run | Folder listings still show the migration date unless the listing also reads metadata (one extra request per item) |
| C | B, plus the listing reads metadata | Complete | Listing cost |

**Rec.** B. The migration writes the original dates in metadata now, so they are preserved whatever is decided.

---

## 3. Edit history without a saved version

**Problem.** da keeps an edit log per document (`.da-versions/{id}/audit.txt`): one line per editing session (same user within 30 min), plus one line per saved version. hlx6 has no edit log; its history only contains versions.

Saved versions migrate one to one. **Editing sessions that did not create a version have nowhere to go.**

**Why it matters.** The da.live history panel shows those sessions ("who edited, when"); after migration they disappear.

**Options**

| | Approach | Pros | Cons |
|---|---|---|---|
| A | Drop them from the UI, archive the raw `audit*.txt` files with the migration record | Simple; nothing lost for audit purposes | Not visible to authors anymore |
| B | Turn each session into an hlx6 version | Visible | Wrong: there is no snapshot of the content at that time, so these "versions" can't be restored |
| C | Add an edit log to hlx6 | Same behaviour as da | New hlx6 feature |

**Rec.** A.

---

## 4. Images that cannot be uploaded

**Problem.** hlx6 does not accept external image URLs in a page: they must be uploaded to the site's media folder and referenced as `./media_{hash}.{ext}`. The migration does this through the official media API (`POST /{org}/sites/{site}/media/`), which validates each image the same way as an author upload. Some images will fail:
- the URL no longer exists
- the file is too large (hlx6 limit 4.5 MB vs 20 MB on da)
- an SVG is rejected because it contains scripts
- the type is not supported

**Why it matters.** hlx6 refuses to save a page that still has an external image. A migrated page with a broken image could be opened but **not saved** from the editor until the image is fixed.

**Options**

| | Approach | Pros | Cons |
|---|---|---|---|
| A | Keep the external URL; report it | Page migrated as-is | Page can't be saved from the hlx6 editor until fixed |
| B | Replace with a placeholder; report it | Page saves | Content changed silently on the live site at next publish |
| C | Don't migrate the page; report it | Explicit | Page missing after migration |

**Rec.** A, with a blocking pre-flight count so site owners fix them before migrating.

---

## 5. Comments

**Problem.** da.live comments (`.da/comments/{docId}/*.json`, since 2026-09-10) are a da-only feature. On hlx6 sites da.live turns them off: the hlx6 API doesn't return the document id that comments are attached to.

**Options**

| | Approach |
|---|---|
| A | Don't migrate comments; a site with comments is flagged by the pre-flight check and needs explicit approval |
| B | Add comments to hlx6 (expose the document id, define where comments are stored), then migrate them, re-attached to the new document ids |

**Status.** Deferred: A for now. The pre-flight check already blocks sites that have comments.

---

## 6. File types hlx6 does not accept

**Problem.** hlx6 only stores `.html .json .gif .ico .jpeg .jpg .mp4 .pdf .png .svg`. da stores any file type (e.g. `.txt`, `.xml`, `.docx`, `.webp`).

**Options**

| | Approach | Pros | Cons |
|---|---|---|---|
| A | Don't migrate them; report them | Simple | Files lost unless the owner moves them elsewhere |
| B | Extend the hlx6 list (`CONTENT_TYPES`) | No loss | hlx6 change; each type needs validation rules |

**Rec.** First measure which types exist on real sites (the pre-flight check counts them), then decide per type.

---

## 7. File names that collide after renaming

**Problem.** hlx6 normalises file and folder names: lowercase, accents removed, anything not `a-z0-9` becomes `-`. da only lowercases. So `my_page.html` and `my-page.html` are two files on da but the same file on hlx6, and `My Page.html` becomes `my-page.html`.

Names that change also break links pointing to them.

**Options**

| | Approach |
|---|---|
| A | Block the site and report; the owner renames before migrating |
| B | Rename automatically with a suffix (`my-page-1.html`) and report |

**Rec.** A for collisions (rare, needs a human choice). Renames without a collision are migrated and reported.

---

## 8. Site config and permissions

**Problem.** da stores org and site config, including permissions, in Cloudflare KV (`DA_CONFIG`). hlx6 uses the helix config service. The content migration does not cover this.

**Questions for the helix team**
- Is config migration part of the site cutover (see 1), or a separate step?
- How do da permissions (path-based, per group) map to hlx6 permissions?

---

## 9. Access for the migration

**Problem.** The migration writes into production buckets that hold every site. A bug must not be able to touch another site.

**Proposal** (details in [01 access and tooling](01-access-and-tooling.md)):
- **One role**, `da-hlx6-migration`, that has **no access by itself**.
- Each run assumes it with tags naming the sites (`org`, `da-site`, `hlx6-site`, `da-content-bus-id`, `hlx6-content-bus-id`). The policy only grants access to the folders built from those tags.
- **Never delete**; no bucket or ACL changes.
- Images go through the media API, so the role needs no write access to the media bucket.
- The code also refuses any write outside the site being migrated.
- On R2: a separate read-only token.

**Needed from account admins:** review [the role policy](../infra/aws/migration-role-policy.json) and [trust policy](../infra/aws/trust-policy.json), set the operator principal, create the role.

If option 1B is chosen, the role also needs write access to `helix-content-bus/{hlx6-content-bus-id}/`.

---

## 10. hlx6 accepts writes into `.trash/`

**Problem.** The hlx6 API lets a client write a file directly into the reserved `.trash/` folder. The result looks like a deleted file but has no original path, and no version from before the delete, so it can't be restored. Deleting through the API works correctly.

**Status.** Reported: [adobe/helix-api-service#456](https://github.com/adobe/helix-api-service/issues/456). It doesn't affect the migration, which sets the original path itself.

---

## Resolved
- **Versions of deleted da documents:** migrated as versions without a document, which is how hlx6 itself behaves after the trash is emptied.
- **Bucket names:** prod uses `helix-source-bus` and `helix-media-bus` (verified with read access).
- **Image upload procedure:** official media API; the media hash `"1" + sha1(size + first 8 KiB)` was verified against a real image ([04 §8](04-migration-rules.md#8-images-r9-upload-procedure)).
