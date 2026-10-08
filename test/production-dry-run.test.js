import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOnlyClient, readOnlyFetch } from '../src/production-dry-run.js';
import { migrateCli } from '../src/migration-cli.js';
import { fakeClient } from './fixtures/fake-client.js';

it('rejects execution outside the approved sample before loading credentials or contacting sites', () => {
  for (const flag of ['-x', '--execute']) {
    const result = spawnSync(process.execPath, ['bin/migrate.js', 'adobecom/da-events', 'kptdobe/da-events-migrated', flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Execution is restricted to the approved sample/);
    assert.equal(result.stdout, '');
  }
});

it('rejects unsafe read concurrency before loading credentials', () => {
  for (const options of [
    ['--concurrency', '0'], ['--concurrency', '65'],
    ['--listing-concurrency', '33'], ['--listing-concurrency', 'not-a-number'],
  ]) {
    const result = spawnSync(process.execPath, ['bin/migrate.js', 'adobecom/da-events', 'kptdobe/da-events-migrated', ...options], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Download concurrency must be/);
    assert.equal(result.stdout, '');
  }
});

it('rejects malformed scopes and conflicting execution modes before reading credentials', () => {
  for (const args of [
    ['adobecom/da-events'], ['../site', 'org/target'], ['org/site/extra', 'org/target'],
    ['org/site', 'org/target', 'extra'], ['org/site', 'org/target', '--dry-run', '-x'],
    ['org/site', 'org/target', '--source-dump', 'unused', '--refresh-source'],
  ]) {
    const result = spawnSync(process.execPath, ['bin/migrate.js', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /ENOENT|credentials|ExpiredToken/);
    assert.equal(result.stdout, '');
  }
});

it('default dry-run reports listing sizes without source or target body/header reads or auth', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-inventory-'));
  const envFile = path.join(directory, 'env');
  const out = path.join(directory, 'report.json');
  await fs.writeFile(envFile, '');
  const da = fakeClient({
    'source-org/source-site/index.html': { body: 'hello world' },
    'source-org/source-site/.da-versions/id/v1.html': { body: 'old' },
    'source-org/source-site/.da-versions/id/audit.txt': { body: 'audit' },
    'source-org/source-site/.trash/deleted.html': { body: 'trash' },
    'source-org/source-site/.da/internal.json': { body: '{}' },
  }, 2);
  const hlx = fakeClient({
    'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
      contentBusId: 'b'.repeat(59), source: { url: 'https://api.aem.live/target-org/sites/target-site/source' },
    } }) },
    'target-org/target-site/index.html': { body: 'old target' },
    'target-org/target-site/.versions/document/snapshot': { body: 'version' },
  });
  const requests = [];
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    const report = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '-e', envFile, '-o', out,
    ], {
      progress,
      createReadClient: (backend) => ({
        async send(command) {
          const name = command.constructor.name;
          requests.push({ name, bucket: command.input.Bucket });
          if (name !== 'ListObjectsV2Command'
            && !(name === 'GetObjectCommand' && command.input.Bucket === 'helix-config-bus')) {
            throw new Error('Inventory must not fetch content bodies or headers');
          }
          return (backend === 'da' ? da : hlx).send(command);
        },
      }),
      tokenProvider: () => { throw new Error('Inventory must not request authentication'); },
      createWriteClient: () => { throw new Error('Inventory must not request writes'); },
      fetchImpl: () => { throw new Error('Inventory must not fetch API content'); },
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.validation, 'inventory');
    assert.deepEqual(report.blockers, []);
    assert.equal(report.sourceObjects, 5);
    assert.equal(report.sourceBytes, 26);
    assert.equal(report.targetObjects, 2);
    assert.equal(report.targetBytes, 17);
    assert.deepEqual(report.sourceSummary, {
      content: { objects: 2, bytes: 13 },
      versionHistory: { objects: 2, bytes: 8 },
      trash: { objects: 1, bytes: 5 },
      internal: { objects: 0, bytes: 0 },
    });
    assert.deepEqual(report.targetSummary, {
      content: { objects: 1, bytes: 10 },
      versionHistory: { objects: 1, bytes: 7 },
      trash: { objects: 0, bytes: 0 },
      internal: { objects: 0, bytes: 0 },
    });
    assert.deepEqual(Object.fromEntries(report.inventory.source.map(({ key, size }) => [key, size])), {
      'source-org/source-site/index.html': 11,
      'source-org/source-site/.da-versions/id/v1.html': 3,
      'source-org/source-site/.da-versions/id/audit.txt': 5,
      'source-org/source-site/.trash/deleted.html': 5,
      'source-org/source-site/.da/internal.json': 2,
    });
    assert.equal(report.inventory.target.find(({ key }) => key.endsWith('/index.html')).size, 10);
    assert.ok(report.skippedChecks.some(({ id }) => id === 'external-images'));
    assert.ok(report.skippedChecks.some(({ id }) => id === 'destination-ownership'));
    assert.ok(report.skippedChecks.some(({ id }) => id === 'project-config'));
    assert.ok(report.skippedChecks.some(({ id }) => id === 'orphan-versions'));
    assert.ok(!report.preflight.checks.some(({ id }) => id === 'orphan-versions'));
    assert.equal(report.plannedObjects, undefined);
    assert.equal(report.imageUrls, undefined);
    assert.ok(requests.every(({ name, bucket }) => name === 'ListObjectsV2Command' || bucket === 'helix-config-bus'));
    assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).sourceBytes, 26);
    const dump = path.join(directory, 'dump');
    await fs.mkdir(dump);
    await fs.writeFile(path.join(dump, 'manifest.json'), JSON.stringify(report.inventory.source.map((entry) => ({
      ...entry, bodyFile: 'files/not-downloaded.html', metadata: { id: 'unused' },
    }))));
    const sourceCalls = da.calls.length;
    const localReport = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '--source-dump', dump,
      '-e', envFile, '-o', path.join(directory, 'local-report.json'),
    ], {
      progress,
      createReadClient: (backend) => {
        assert.equal(backend, 'hlx6');
        return hlx;
      },
      tokenProvider: () => { throw new Error('Local inventory must not request authentication'); },
    });
    assert.deepEqual(localReport.blockers, []);
    assert.equal(localReport.sourceObjects, 5);
    assert.equal(localReport.sourceBytes, 26);
    assert.deepEqual(localReport.sourceSummary, report.sourceSummary);
    assert.equal(da.calls.length, sourceCalls);
    assert.ok(localReport.inventory.source.every((entry) => !entry.body && !entry.bodyFile && !entry.metadata));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('full validation dry-runs cross-org sites with correct target keys, config URLs, and no writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-cli-'));
  const envFile = path.join(directory, 'env');
  const out = path.join(directory, 'report.json');
  await fs.writeFile(envFile, '');
  const source = 'source-org/source-site';
  const target = 'target-org/target-site';
  const config = { content: { contentBusId: 'b'.repeat(59), source: {
    url: 'https://api.aem.live/target-org/sites/target-site/source',
  } } };
  const da = fakeClient({ [`${source}/index.html`]: {
    body: '<body><main>Event</main></body>', metadata: { id: 'document-1' },
  } });
  const hlx = fakeClient({
    'orgs/target-org/sites/target-site.json': { body: JSON.stringify(config) },
    'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
  });
  const requests = [];
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    const report = await migrateCli([source, target, '--full-validation', '-e', envFile, '-o', out], {
      createReadClient: (backend) => (backend === 'da' ? da : hlx),
      createWriteClient: () => { throw new Error('Write credentials must not be requested'); },
      tokenProvider: () => 'test-token',
      progress,
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method || 'GET' });
        return { ok: true, json: async () => ({}) };
      },
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.validation, 'full');
    assert.equal(report.source, source);
    assert.equal(report.target, target);
    assert.equal(report.objects, 1);
    assert.deepEqual(report.statuses, [{ key: `${target}/index.html`, status: 'planned' }]);
    assert.equal(report.projectConfig.status, 'planned');
    assert.equal(report.sourceContentBusId, 'a'.repeat(59));
    assert.equal(report.targetContentBusId, 'b'.repeat(59));
    assert.deepEqual(requests, [
      { url: 'https://admin.da.live/config/source-org/source-site', method: 'GET' },
      { url: 'https://api.aem.live/target-org/sites/target-site/config.json', method: 'GET' },
    ]);
    assert.ok([...da.calls, ...hlx.calls].every((name) => ['ListObjectsV2Command', 'GetObjectCommand', 'HeadObjectCommand'].includes(name)));
    assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).dryRun, true);
    assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
    await assert.rejects(migrateCli([source, target, '-e', envFile, '-o', out], { progress }), /EEXIST/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('full validation reclassifies legacy .da exclusions in a local source dump', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-legacy-da-'));
  const dump = path.join(directory, 'dump');
  const envFile = path.join(directory, 'env');
  await fs.mkdir(dump);
  await fs.writeFile(envFile, '');
  await fs.writeFile(path.join(dump, 'content.json'), '{}');
  await fs.writeFile(path.join(dump, 'manifest.json'), JSON.stringify([{
    key: 'source-org/source-site/.da/anotherfile.json', rel: '/.da/anotherfile.json',
    kind: 'da-internal', size: 2, bodyFile: 'content.json', metadata: { id: 'legacy-1' },
  }]));
  const hlx = fakeClient({
    'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
      contentBusId: 'b'.repeat(59), source: { url: 'https://api.aem.live/target-org/sites/target-site/source' },
    } }) },
  });
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    const report = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '--full-validation', '--source-dump', dump,
      '-e', envFile, '-o', path.join(directory, 'report.json'),
    ], {
      progress,
      createReadClient: (backend) => { assert.equal(backend, 'hlx6'); return hlx; },
      tokenProvider: () => 'test-token',
      fetchImpl: async () => ({ status: 404 }),
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.objects, 1);
    assert.deepEqual(report.excluded, []);
    assert.deepEqual(report.statuses, [{ key: 'target-org/target-site/.da/anotherfile.json', status: 'planned' }]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('records target and source-scope blockers without requesting write clients or tokens', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-blockers-'));
  const envFile = path.join(directory, 'env');
  const dump = path.join(directory, 'dump');
  await fs.writeFile(envFile, '');
  await fs.mkdir(dump);
  await fs.writeFile(path.join(dump, 'manifest.json'), JSON.stringify([
    { key: 'wrong-org/wrong-site/index.html', rel: '/index.html', kind: 'doc', size: 1 },
  ]));
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    for (const scenario of ['invalid-target', 'wrong-source-dump']) {
      const out = path.join(directory, `${scenario}.json`);
      const client = fakeClient({
        'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
          contentBusId: 'b'.repeat(59), source: { url: scenario === 'invalid-target'
            ? 'https://admin.da.live/source/target-org/target-site'
            : 'https://api.aem.live/target-org/sites/target-site/source' },
        } }) },
      });
      const report = await migrateCli([
        'source-org/source-site', 'target-org/target-site', '-e', envFile, '-o', out,
        '--source-dump', dump,
      ], {
        progress,
        createReadClient: () => client,
        createWriteClient: () => { throw new Error('Unexpected write client'); },
        tokenProvider: () => { throw new Error('Unexpected token request'); },
      });
      assert.equal(report.dryRun, true);
      assert.equal(report.blockers.length, 1);
      assert.match(report.blockers[0], scenario === 'invalid-target'
        ? /Target is not configured/ : /outside the requested DA site/);
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')).blockers, report.blockers);
      assert.ok(client.calls.every((name) => name === 'GetObjectCommand'));
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('returns a nonzero CLI exit and saves a blocker report when credentials cannot be loaded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-exit-'));
  const out = path.join(directory, 'report.json');
  try {
    const result = spawnSync(process.execPath, [
      'bin/migrate.js', 'source-org/source-site', 'target-org/target-site',
      '-e', path.join(directory, 'missing-env'), '-o', out,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.equal(report.dryRun, true);
    assert.match(report.blockers[0], /ENOENT/);
    assert.match(result.stdout, /Source: org=source-org; repo=source-site/);
    assert.match(result.stdout, /Target: org=target-org; repo=target-site/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('permits storage reads but refuses writes before sending them', async () => {
  const calls = [];
  const client = readOnlyClient({ send: async (command) => calls.push(command.constructor.name) });
  class ListObjectsV2Command {}
  class PutObjectCommand {}
  await client.send(new ListObjectsV2Command());
  await assert.rejects(client.send(new PutObjectCommand()), /Read-only/);
  assert.deepEqual(calls, ['ListObjectsV2Command']);
});

it('permits GET but refuses config and media mutations before fetching', async () => {
  const calls = [];
  const fetchImpl = readOnlyFetch(async (url) => { calls.push(url); return { ok: true }; });
  assert.equal((await fetchImpl('https://example.com/config')).ok, true);
  await assert.rejects(fetchImpl('https://example.com/config', { method: 'POST' }), /Read-only/);
  assert.deepEqual(calls, ['https://example.com/config']);
});