#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BACKENDS, applyDevVars, createClient, createMigrationClient, getObject } from '../src/storage.js';
import { scanSite, readDump, writeDump } from '../src/dump.js';
import { buildMigrationPlan } from '../src/migration.js';
import { runMigration } from '../src/migration-runner.js';
import { migrateProjectConfig } from '../src/project-config.js';
import { createScope } from '../src/scope.js';
import { getDaAuthToken } from '../src/auth.js';

const TEST = Object.freeze({
  org: 'kptdobe',
  daSite: 'sample-content-da',
  hlx6Site: 'sample-content-hlx6-migrated',
  daContentBusId: 'cdb7c31a0884cd980ae35142093dbd9e12dd50a3ad8f106e472d50255a8',
  hlx6ContentBusId: '8a228067304382d0717c282ae08947b512ada27852b0c144dc9ba0afce4',
});
const ROLE_ARN = 'arn:aws:iam::118435662149:role/da-hlx6-migration';
const SOURCE_DUMP = path.join('analysis', 'da', TEST.org, TEST.daSite);
const TARGET_CONFIG_KEY = `orgs/${TEST.org}/sites/${TEST.hlx6Site}.json`;
const USAGE = `Usage: node bin/migrate.js [options]

Pinned test migration only:
  ${TEST.org}/${TEST.daSite} -> ${TEST.org}/${TEST.hlx6Site}

Options:
  -x, --execute       write to the test target (requires scoped AWS role)
      --overwrite     rewrite planned target content (still dry-run without -x)
  -e, --env-file      single local credentials/config file (default: .dev.vars)
      --refresh-source fetch a fresh da dump before planning (read-only R2)
      --source-dump    local da dump directory (default: ${SOURCE_DUMP})
  -o, --out           JSON run report (default: analysis/migration-sample.json)
  -h, --help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    execute: { type: 'boolean', short: 'x' },
    overwrite: { type: 'boolean' },
    'env-file': { type: 'string', short: 'e', default: '.dev.vars' },
    'refresh-source': { type: 'boolean' },
    'source-dump': { type: 'string', default: SOURCE_DUMP },
    out: { type: 'string', short: 'o', default: 'analysis/migration-sample.json' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const envContent = await fs.readFile(values['env-file'], 'utf8');
applyDevVars(envContent);

const scope = createScope(TEST);
if (values.execute && process.env.MIGRATION_ROLE_ARN && process.env.MIGRATION_ROLE_ARN !== ROLE_ARN) {
  throw new Error(`Refusing unexpected migration role: ${process.env.MIGRATION_ROLE_ARN}`);
}
if (values.execute && !values['refresh-source']) {
  throw new Error('Execution requires --refresh-source so the migration uses a current DA snapshot');
}
if (values.execute && !['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'].every((key) => process.env[key])) {
  throw new Error('Execution requires read-only R2 credentials in the selected env file');
}
if (values['refresh-source']) {
  const daClient = createClient('da', { devVarsPath: values['env-file'] });
  const entries = await scanSite({
    client: daClient,
    backend: 'da',
    bucket: BACKENDS.da.bucket,
    org: TEST.org,
    site: TEST.daSite,
    withBodies: true,
  });
  await writeDump(values['source-dump'], entries);
  console.log(`Refreshed read-only DA dump: ${values['source-dump']} (${entries.length} objects)`);
}

const entries = await readDump(values['source-dump']);
if (!entries.length || entries.some((entry) => !entry.key.startsWith(`${TEST.org}/${TEST.daSite}/`))) {
  throw new Error('Source dump is empty or contains keys outside the approved DA test site');
}
const plan = buildMigrationPlan(entries, TEST);

const hlxClient = values.execute
  ? createMigrationClient(scope, process.env.MIGRATION_ROLE_ARN || ROLE_ARN)
  : createClient('hlx6');
const targetConfig = await getObject(hlxClient, 'helix-config-bus', TARGET_CONFIG_KEY);
const config = JSON.parse(targetConfig.body.toString('utf8'));
if (config.content?.contentBusId !== TEST.hlx6ContentBusId) {
  throw new Error('Target contentBusId changed; refusing to run with stale IAM scope');
}
const expectedSourceUrl = `https://api.aem.live/${TEST.org}/sites/${TEST.hlx6Site}/source`;
if (config.content?.source?.url !== expectedSourceUrl) {
  throw new Error('Target source URL does not match the approved test site');
}

const apiToken = getDaAuthToken();
const configOptions = {
  scope,
  daConfigToken: apiToken,
  configToken: apiToken,
};
let projectConfig = await migrateProjectConfig(configOptions);

console.log(`${values.execute ? 'EXECUTE' : 'DRY RUN'} ${TEST.org}/${TEST.daSite} -> ${TEST.org}/${TEST.hlx6Site}`);
const result = await runMigration(plan, {
  client: hlxClient,
  scope,
  execute: values.execute,
  overwrite: values.overwrite,
  mediaToken: apiToken,
  daSourceToken: apiToken,
  onProgress: ({ key, status }) => console.log(`${status} ${key}`),
});

if (values.execute && projectConfig.status === 'planned') {
  projectConfig = await migrateProjectConfig({ ...configOptions, execute: true });
}
console.log(`Project config: ${projectConfig.status}`);

const report = {
  source: `${TEST.org}/${TEST.daSite}`,
  target: `${TEST.org}/${TEST.hlx6Site}`,
  dryRun: result.dryRun,
  overwrite: Boolean(values.overwrite),
  objects: result.objects,
  imageUrls: result.imageUrls,
  excluded: plan.excluded,
  warnings: plan.warnings,
  statuses: [...result.statuses.entries()].map(([key, status]) => ({ key, status })),
  results: result.results,
  projectConfig,
};
await fs.mkdir(path.dirname(values.out), { recursive: true });
await fs.writeFile(values.out, JSON.stringify(report, null, 2));
console.log(`Report: ${values.out}`);
console.log(`Objects: ${result.objects}; distinct external images: ${result.imageUrls.length}`);
if (!values.execute && result.imageUrls.length) {
  console.log('Dry run did not upload images. Execution requires a target-scoped media:upload token.');
}