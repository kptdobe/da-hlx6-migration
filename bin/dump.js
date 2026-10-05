#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { BACKENDS, createClient } from '../src/storage.js';
import { scanSite, writeDump } from '../src/dump.js';

const USAGE = `Usage: node bin/dump.js -b <da|hlx6> [options] <org/site>

Read-only: downloads every object of a site (bodies + metadata) to a local folder.

Options:
  -b, --backend    da (R2) or hlx6 (S3)                       (required)
  -o, --out        output folder              (default: analysis/<backend>/<org>/<site>)
      --bucket     bucket override            (default: ${BACKENDS.da.bucket} / ${BACKENDS.hlx6.bucket})
  -e, --env-file  local env file for da (default: .dev.vars)
      --no-bodies  only fetch metadata (HEAD)
  -c, --concurrency                           (default: 20)
  -h, --help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: 'string', short: 'b' },
    out: { type: 'string', short: 'o' },
    bucket: { type: 'string' },
    'env-file': { type: 'string', short: 'e', default: '.dev.vars' },
    'no-bodies': { type: 'boolean', default: false },
    concurrency: { type: 'string', short: 'c', default: '20' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [org, site] = (positionals[0] || '').split('/');
if (values.help || !org || !site || !BACKENDS[values.backend]) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const backend = values.backend;
const bucket = values.bucket || BACKENDS[backend].bucket;
const outDir = values.out || path.join('analysis', backend, org, site);
const client = createClient(backend, { devVarsPath: values['env-file'] });

console.log(`Scanning ${backend} s3://${bucket}/${org}/${site}/ ...`);
const entries = await scanSite({
  client, backend, bucket, org, site,
  withBodies: !values['no-bodies'],
  concurrency: Number(values.concurrency),
});
await writeDump(outDir, entries);

const kinds = {};
entries.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
console.log(`${entries.length} objects written to ${outDir}`);
console.table(kinds);
