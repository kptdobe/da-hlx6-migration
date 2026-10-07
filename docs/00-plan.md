# 00 - Migration plan: da → hlx6

We work step by step. Each phase produces a document, and that document drives the next phase.
No migration code is written before the migration rules (04) and the architecture (05) are agreed.

## Decisions taken
| Topic | Decision |
|---|---|
| Version history | **Full migration** is required |
| da-magic utils | **Copy** them into this repo (no dependency) |
| Automated live delta sync | Out of scope; operator freeze, verification, and cutover flow is documented in [README](../README.md#main-migration-flow) |
| Runtime (CLI vs AWS service) | Not decided. Core logic must stay library-shaped |

## Phases
| # | Phase | Deliverable | Status |
|---|---|---|---|
| 0 | Access & tooling inventory | [01-access-and-tooling.md](01-access-and-tooling.md) | **done** |
| 1 | Storage model from source code | [02-storage-model.md](02-storage-model.md) | **done (v1)** |
| 2 | Read-only tooling: list/head/get on R2 and S3, plus dump | `src/`, `bin/` | **done** |
| 3 | Dump both sample projects and diff them | [03-content-structure-differences.md](03-content-structure-differences.md) | **done (v1)** |
| 4 | Migration rules | [04-migration-rules.md](04-migration-rules.md) | **v1, in review** |
| 5 | Architecture ADR | [05-architecture.md](05-architecture.md) | draft |
| 6 | Migration engine | code + tests | later |
| 7 | Verification tooling | code + tests | later |

Phase 1 was done first because the source code tells us *what to look for* in the dumps.
Phase 3 then confirms or refutes each item of 02 on real data.

## Comparison caveat
The two sample projects have the same **content**, but their **version history differs**:
- timestamps are necessarily different
- the order of events may differ

The diff is therefore **structural**. It covers key mapping, body equality, metadata key sets,
and the number and shape of versions. Before diffing, volatile values (timestamps, IDs, ULIDs,
UUIDs, ETags, users) are normalized.

## Coding rules (from Phase 2 onward)
- Scripts take parameters: `node bin/x.js -flags input...`
- Any write is a dry-run by default; `-x` executes
- Use `@adobe/helix-shared-process-queue` for parallelism
- Use exact dependency versions
- Every module gets scenario-driven unit tests
- `npm run lint` must be clean
- The IMS token comes from `da-auth/src/cli.js token` and is never printed
