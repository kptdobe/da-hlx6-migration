import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { BACKENDS, applyDevVars, createClient, createMigrationClient, getObject, listSharded } from './storage.js';
import { scanSite, readDump, writeDump } from './dump.js';
import { classifyDa, classifyHlx6 } from './classify.js';
import { preflight } from './preflight.js';
import { buildMigrationPlan } from './migration.js';
import { runMigration } from './migration-runner.js';
import { migrateProjectConfig } from './project-config.js';
import { createScope } from './scope.js';
import { createProgress } from './progress.js';
import { readOnlyClient, readOnlyFetch } from './production-dry-run.js';

const SAMPLE = Object.freeze({
  org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6-migrated',
  daContentBusId: 'cdb7c31a0884cd980ae35142093dbd9e12dd50a3ad8f106e472d50255a8',
  hlx6ContentBusId: '8a228067304382d0717c282ae08947b512ada27852b0c144dc9ba0afce4',
});
const ROLE_ARN = 'arn:aws:iam::118435662149:role/da-hlx6-migration';
const SAMPLE_DUMP = path.join('analysis', 'da', SAMPLE.org, SAMPLE.daSite);
const SITE = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;
const USAGE = `Usage: node bin/migrate.js [options] <source-org/source-site> <target-org/target-site>

Listing-only dry-run by default; no content bodies or headers are fetched.
Without site arguments, uses the existing sample migration.
Generic migrations are read-only; execution remains restricted to the approved sample.

Options:
      --dry-run           explicitly select read-only inventory (default)
      --full-validation   download source objects for full migration validation
  -x, --execute           execute the approved sample only (requires --refresh-source)
      --overwrite         plan overwrites; writes still require -x
  -e, --env-file          credentials/config file (default: .dev.vars)
      --source-dump       plan from a local DA dump instead of scanning live
      --refresh-source    scan live; refresh --source-dump if provided
      --concurrency       download workers (1..64, default: 24)
      --listing-concurrency listing workers (1..32, default: 8)
  -o, --out               new JSON report path (default: timestamped file in analysis/)
  -h, --help`;

function summarizeInventory(entries, site, backend) {
  const summary = {
    content: { objects: 0, bytes: 0 },
    versionHistory: { objects: 0, bytes: 0 },
    trash: { objects: 0, bytes: 0 },
    internal: { objects: 0, bytes: 0 },
  };
  const classify = backend === 'da' ? classifyDa : classifyHlx6;
  const historyPrefix = backend === 'da' ? '/.da-versions/' : '/.versions/';
  for (const entry of entries) {
    const rel = entry.key.slice(site.length);
    const { kind } = classify(rel);
    let category;
    if (rel.startsWith(historyPrefix)) category = 'versionHistory';
    else if (kind === 'trash') category = 'trash';
    else if (['doc', 'sheet', 'media', 'folder'].includes(kind)) category = 'content';
    else category = 'internal';
    summary[category].objects += 1;
    summary[category].bytes += entry.size;
  }
  return summary;
}

export async function migrateCli(args, {
  createReadClient = createClient,
  createWriteClient = createMigrationClient,
  tokenProvider = () => process.env.DA_CONFIG_TOKEN || execFileSync('/Users/acapt/work/dev/helix/da/da-auth/src/cli.js', ['token'], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'],
  }).trim(),
  fetchImpl = fetch,
  progress: suppliedProgress,
} = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      execute: { type: 'boolean', short: 'x' },
      'dry-run': { type: 'boolean' },
      'full-validation': { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'env-file': { type: 'string', short: 'e', default: '.dev.vars' },
      'refresh-source': { type: 'boolean' },
      'source-dump': { type: 'string' },
      concurrency: { type: 'string', default: '24' },
      'listing-concurrency': { type: 'string', default: '8' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return undefined;
  }
  if (positionals.length !== 0 && positionals.length !== 2) {
    throw new Error('Expected source-org/source-site and target-org/target-site');
  }
  const [source = `${SAMPLE.org}/${SAMPLE.daSite}`, target = `${SAMPLE.org}/${SAMPLE.hlx6Site}`] = positionals;
  if (!SITE.test(source) || !SITE.test(target)) throw new Error('Invalid source or target: expected org/site');
  if (values.execute && values['dry-run']) throw new Error('--execute and --dry-run cannot be combined');
  const approvedSample = source === `${SAMPLE.org}/${SAMPLE.daSite}`
    && target === `${SAMPLE.org}/${SAMPLE.hlx6Site}`;
  if (values.execute && !approvedSample) {
    throw new Error('Execution is restricted to the approved sample; other sites support dry-run only');
  }
  if (values.execute && !values['refresh-source']) {
    throw new Error('Execution requires --refresh-source so the migration uses a current DA snapshot');
  }
  const concurrency = Number(values.concurrency);
  const listingConcurrency = Number(values['listing-concurrency']);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64
    || !Number.isInteger(listingConcurrency) || listingConcurrency < 1 || listingConcurrency > 32) {
    throw new Error('Download concurrency must be 1..64; listing concurrency must be 1..32');
  }
  const [daOrg, daSite] = source.split('/');
  const [org, hlx6Site] = target.split('/');
  const execute = Boolean(values.execute);
  const fullValidation = execute || Boolean(values['full-validation']);
  if (!fullValidation && values['source-dump'] && values['refresh-source']) {
    throw new Error('Refreshing a source dump requires --full-validation');
  }
  const scope = execute ? createScope(SAMPLE) : Object.freeze({
    org, daOrg, daSite, hlx6Site, write: Object.freeze([]),
  });
  const sourceDump = values['source-dump'] || (execute && !positionals.length ? SAMPLE_DUMP : undefined);
  const startedAt = new Date().toISOString();
  const out = values.out || path.join('analysis',
    `migration-${daOrg}-${daSite}-to-${org}-${hlx6Site}-${startedAt.replaceAll(':', '-')}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const reportFile = await fs.open(out, 'wx', 0o600);
  const progress = suppliedProgress || createProgress();
  const report = {
    source, target, dryRun: !execute, overwrite: Boolean(values.overwrite), startedAt,
    validation: fullValidation ? 'full' : 'inventory',
    concurrency, listingConcurrency, retryMode: 'adaptive', blockers: [],
    ...(!fullValidation && { skippedChecks: [
      { id: 'orphan-versions', reason: 'Requires source object identity metadata; inventory does not fetch headers' },
      { id: 'migration-plan', reason: 'Requires document metadata and audit/version bodies; use --full-validation' },
      { id: 'destination-ownership', reason: 'Requires migration hashes and target ownership metadata' },
      { id: 'external-images', reason: 'Requires parsing source HTML bodies' },
      { id: 'project-config', reason: 'Project config comparison is part of --full-validation' },
    ] }),
  };
  try {
    progress.summary(`${execute ? 'EXECUTE' : 'DRY RUN; remote writes disabled'}; validation=${report.validation}; downloads=${fullValidation ? concurrency : 'disabled'}; listing=${listingConcurrency}; adaptive retries`, {
      org: daOrg, repo: daSite, bucket: BACKENDS.da.bucket,
    }, { org, repo: hlx6Site, bucket: BACKENDS.hlx6.bucket });
    applyDevVars(await progress.run('Loading credentials (not logged)', () => fs.readFile(values['env-file'], 'utf8')));
    if (execute && process.env.MIGRATION_ROLE_ARN && process.env.MIGRATION_ROLE_ARN !== ROLE_ARN) {
      throw new Error(`Refusing unexpected migration role: ${process.env.MIGRATION_ROLE_ARN}`);
    }
    if (execute && !['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'].every((key) => process.env[key])) {
      throw new Error('Execution requires read-only R2 credentials in the selected env file');
    }
    const hlxClient = execute ? createWriteClient(scope, ROLE_ARN)
      : readOnlyClient(createReadClient('hlx6', { retryMode: 'adaptive' }));
    const targetConfig = await progress.run('Reading target site config', () => getObject(hlxClient,
      'helix-config-bus', `orgs/${org}/sites/${hlx6Site}.json`));
    const config = JSON.parse(targetConfig.body.toString('utf8'));
    const expectedUrl = `https://api.aem.live/${org}/sites/${hlx6Site}/source`;
    if (config.content?.source?.url !== expectedUrl
      || !/^[0-9a-f]{32,64}$/.test(config.content?.contentBusId || '')) {
      throw new Error('Target is not configured as the expected HLX6 site; refusing to plan');
    }
    if (execute && config.content.contentBusId !== SAMPLE.hlx6ContentBusId) {
      throw new Error('Target contentBusId changed; refusing to run with stale IAM scope');
    }
    report.targetContentBusId = config.content.contentBusId;
    progress.log(`Target: org=${org}; repo=${hlx6Site}; contentBusId=${report.targetContentBusId}; sourceUrl=${expectedUrl}`);
    if (execute) {
      report.sourceContentBusId = SAMPLE.daContentBusId;
    } else {
      try {
        const sourceConfig = await progress.run('Reading source site config', () => getObject(hlxClient,
          'helix-config-bus', `orgs/${daOrg}/sites/${daSite}.json`));
        const sourceContent = JSON.parse(sourceConfig.body.toString('utf8')).content;
        report.sourceContentBusId = sourceContent?.fixedContentBusId || sourceContent?.contentBusId;
      } catch (error) {
        if (!['NoSuchKey', 'AccessDenied'].includes(error.name)) throw error;
        report.sourceConfigWarning = `Source content bus ID unavailable: ${error.name}`;
        progress.log(report.sourceConfigWarning);
      }
    }
    progress.log(`Source: org=${daOrg}; repo=${daSite}; contentBusId=${report.sourceContentBusId || 'unknown (not accessible)'}`);
    let entries;
    if (values['refresh-source'] || !sourceDump) {
      const daClient = readOnlyClient(createReadClient('da', {
        devVarsPath: values['env-file'], retryMode: 'adaptive',
      }));
      if (fullValidation) {
        entries = await scanSite({
          client: daClient, backend: 'da', bucket: BACKENDS.da.bucket, org: daOrg, site: daSite,
          concurrency, listingConcurrency, onProgress: progress.onProgress,
        });
        if (sourceDump) await progress.run('Saving source snapshot', () => writeDump(sourceDump, entries, { onProgress: progress.onProgress }));
      } else {
        entries = await listSharded(daClient, BACKENDS.da.bucket, `${source}/`, {
          concurrency: listingConcurrency, onProgress: progress.onProgress,
        });
      }
    } else {
      entries = fullValidation ? await readDump(sourceDump, { onProgress: progress.onProgress })
        : await progress.run('Reading local source inventory (manifest only)', async () => JSON.parse(
          await fs.readFile(path.join(sourceDump, 'manifest.json'), 'utf8'),
        ));
    }
    if (!entries.length || entries.some((entry) => !entry.key.startsWith(`${source}/`))) {
      throw new Error('Source is empty or contains keys outside the requested DA site');
    }
    if (fullValidation) {
      entries = entries.map((entry) => {
        const rel = `/${entry.key.slice(source.length + 1)}`;
        return {
          ...entry, rel, path: undefined, docId: undefined, versionId: undefined, trashedKind: undefined,
          ...classifyDa(rel),
        };
      });
    }
    report.sourceObjects = entries.length;
    report.sourceBytes = entries.reduce((total, entry) => total + entry.size, 0);
    report.sourceSummary = summarizeInventory(entries, source, 'da');
    for (const [category, { objects, bytes }] of Object.entries(report.sourceSummary)) {
      progress.log(`Source ${category}: ${objects} objects; ${bytes} stored bytes`);
    }
    if (!fullValidation) {
      entries = entries.map(({ key, size, etag, lastModified }) => {
        const rel = `/${key.slice(source.length + 1)}`;
        return { key, size, etag, lastModified, rel, ...classifyDa(rel) };
      });
      const targetEntries = await listSharded(hlxClient, BACKENDS.hlx6.bucket, `${target}/`, {
        concurrency: listingConcurrency, onProgress: progress.onProgress,
      });
      report.targetObjects = targetEntries.length;
      report.targetBytes = targetEntries.reduce((total, entry) => total + entry.size, 0);
      report.targetSummary = summarizeInventory(targetEntries, target, 'hlx6');
      for (const [category, { objects, bytes }] of Object.entries(report.targetSummary)) {
        progress.log(`Target ${category}: ${objects} objects; ${bytes} stored bytes`);
      }
      report.inventory = { source: entries, target: targetEntries, sizeUnit: 'stored bytes' };
      report.preflight = await progress.run('Checking listing-based paths only', () => preflight(entries));
      report.preflight.scope = 'paths-only';
      report.preflight.checks = report.preflight.checks.filter(({ id }) => id !== 'orphan-versions');
      report.warnings = report.preflight.checks.filter((check) => check.severity === 'warning' && check.count);
      progress.log(`Source inventory: ${report.sourceObjects} objects; ${report.sourceBytes} stored bytes`);
      progress.log(`Target inventory: ${report.targetObjects} objects; ${report.targetBytes} stored bytes`);
      for (const { id, reason } of report.skippedChecks) progress.log(`SKIPPED ${id}: ${reason}`);
      if (!report.preflight.ok) throw new Error('Source path checks have blockers; see inventory report');
      return report;
    }
    report.preflight = await progress.run('Checking source preflight', () => preflight(entries));
    if (!report.preflight.ok) throw new Error('Source preflight has blocking checks; see report');
    const plan = await progress.run('Building migration plan', () => buildMigrationPlan(entries, scope));
    report.excluded = plan.excluded;
    report.warnings = plan.warnings;
    report.plannedObjects = plan.objects.map(({ key, sourceKey, kind }) => ({ key, sourceKey, kind }));
    progress.log(`Plan: ${plan.objects.length} objects; ${plan.excluded.length} excluded; ${plan.warnings.length} warnings`);
    const apiToken = await progress.run('Obtaining DA auth token (not logged)', tokenProvider);
    const configOptions = {
      scope, daConfigToken: apiToken, configToken: apiToken, onProgress: progress.onProgress,
      fetchImpl: execute ? fetchImpl : readOnlyFetch(fetchImpl),
    };
    report.projectConfig = await progress.run('Checking project config conflicts', () => migrateProjectConfig(configOptions));
    const result = await progress.run(execute ? 'Running migration' : 'Inspecting target and planning images', () => runMigration(plan, {
      client: hlxClient, scope, execute, overwrite: values.overwrite,
      mediaToken: apiToken, daSourceToken: apiToken, fetchImpl: configOptions.fetchImpl,
      onProgress: progress.onProgress,
    }));
    report.objects = result.objects;
    report.imageUrls = result.imageUrls;
    report.statuses = [...result.statuses].map(([key, status]) => ({ key, status }));
    report.results = result.results;
    if (execute && report.projectConfig.status === 'planned') {
      report.projectConfig = await progress.run('Migrating project config', () => migrateProjectConfig({ ...configOptions, execute: true }));
    }
    progress.log(`Project config: ${report.projectConfig.status}`);
    progress.log(`Objects: ${result.objects}; external images${execute ? '' : ' (not uploaded)'}: ${result.imageUrls.length}`);
  } catch (error) {
    report.blockers.push(error.message);
    progress.log(`Blocked: ${error.message}`);
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      await reportFile.writeFile(JSON.stringify(report, null, 2));
    } finally {
      await reportFile.close();
      progress.log(`Report: ${out}`);
      progress.close();
    }
  }
  return report;
}