# 05 - Architecture (ADR, pending)

Decided after 03 and 04 are stable.

| Option | Pros | Cons |
|---|---|---|
| A. Standalone CLI (laptop / EC2) | Simple, fast to build | Long runs at millions of objects; the machine must stay up |
| B. AWS service (Step Functions / SQS fan-out to Lambda or ECS), triggered per project | Scales, resumable, close to S3 | More infrastructure |
| C. Shared core library + CLI now, service later | Starts small; no rewrite | The core must stay runtime-agnostic (no fs or process access in the core) |

Current lean: **C**.

## Facts that matter
- R2 egress is free. The S3 PUT/COPY cost is about $5 per 1M requests, and versions multiply the object count.
- Writing to S3 cannot use server-side copy (cross-provider), so every body is streamed through the worker.
- Bodies must be gzipped (hlx6 convention). That is CPU cost per object.
- S3 throughput is 3,500 PUT/s per prefix; `{org}/{site}/` is a single prefix, so sharding helps.
- Resumability: a manifest of `{daKey, hlx6Key, etag, status}` (local JSONL for the CLI, DynamoDB/S3 for the service).

## Inputs still needed
- Volume profile of the biggest projects: object count, version count, media share
- Media interning rate (images per doc)
