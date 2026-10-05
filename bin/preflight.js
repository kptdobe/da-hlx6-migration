#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { BACKENDS, createClient } from '../src/storage.js';
import { scanSite, readDump } from '../src/dump.js';
import { preflight } from '../src/preflight.js';

const USAGE = `Usage: node bin/preflight.js [options] <org/site>
       node bin/preflight.js --dump <da-dump-dir>

Read-only: checks a da site for anything that blocks or alters a migration to hlx6.
Exits with code 2 when a blocking check fails.

Options:
      --dump       use a local dump (bin/dump.js -b da) instead of scanning R2
      --bucket     R2 bucket          (default: ${BACKENDS.da.bucket})
  -e, --env-file  local env file (default: .dev.vars)
  -v, --verbose    list affected items
  -h, --help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dump: { type: 'string' },
    bucket: { type: 'string' },
    'env-file': { type: 'string', short: 'e', default: '.dev.vars' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [org, site] = (positionals[0] || '').split('/');
if (values.help || (!values.dump && (!org || !site))) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const entries = values.dump
  ? await readDump(values.dump)
  : await scanSite({
    client: createClient('da', { devVarsPath: values['env-file'] }),
    backend: 'da',
    bucket: values.bucket || BACKENDS.da.bucket,
    org,
    site,
    withBodies: false,
  });

const result = preflight(entries);
console.table(result.checks.map(({
  id, severity, count, description,
}) => ({
  id, severity, count, status: count === 0 ? 'ok' : severity.toUpperCase(), description,
})));
if (values.verbose) {
  result.checks.filter((c) => c.count).forEach((c) => {
    console.log(`\n${c.id}:`);
    c.items.forEach((i) => console.log(`  ${typeof i === 'string' ? i : JSON.stringify(i)}`));
  });
}
console.log(result.ok ? '\nPre-flight OK' : '\nPre-flight BLOCKED');
process.exit(result.ok ? 0 : 2);
