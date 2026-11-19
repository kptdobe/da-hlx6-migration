import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeIgnoredFolders, selectMigrationEntries } from '../src/migration-selection.js';
import { migrateCli } from '../src/migration-cli.js';
import { readDump } from '../src/dump.js';
import { fakeClient } from './fixtures/fake-client.js';

const source = 'org/source';
const ignoredFolders = ['/drafts/esp-dev', '/drafts/esp-stage'];
const progress = {
  summary() {}, log() {}, onProgress() {}, close() {},
  async run(label, action) { return action(); },
};

it('validates literal site folders and deduplicates nested/trailing-slash paths', () => {
  assert.deepEqual(normalizeIgnoredFolders(), []);
  assert.deepEqual(normalizeIgnoredFolders([
    '/drafts/esp-dev/', '/drafts/esp-dev/nested', '/drafts/esp-dev', '/Drafts/%2F',
  ]), ['/drafts/esp-dev', '/Drafts/%2F']);
  for (const input of ['x', null, [null], [''], ['/'], ['//'], ['drafts'], ['/a//b'], ['/a/../b'], ['/a/./b'], ['/a\nb']]) {
    assert.throws(() => normalizeIgnoredFolders(input), /Ignored folders|site root/);
  }
});

it('filters by boundaries, folder markers, IDs and orphan hints, not stale manifest classification', async () => {
  const entry = (rel, metadata = {}) => ({ key: `${source}${rel}`, metadata, kind: 'wrong' });
  const entries = [
    entry('/drafts/esp-dev.props', { id: 'folder' }),
    entry('/drafts/esp-dev/nested/a.html', { id: 'ignored' }),
    entry('/drafts/esp-dev/nested/a.html.props'),
    entry('/drafts/esp-stage/b.json', { id: 'stage' }),
    entry('/.da-versions/ignored/old.html', { path: 'source/previous.html' }),
    entry('/.da-versions/ignored/audit.txt'),
    entry('/.da-versions/ignored/audit-1000.txt'),
    entry('/.da-versions/stage/v.json'),
    entry('/.da-versions/orphan/v.html', { path: 'source/drafts/esp-dev/deleted.html' }),
    entry('/drafts/esp-dev-other/keep.html'),
    entry('/Drafts/esp-dev/keep.html'),
    entry('/.da-versions/keep/v.html', { path: 'source/keep.html' }),
  ];
  const excluded = [];
  const selected = await selectMigrationEntries(entries, {
    source, ignoredFolders, onExcluded: (item) => excluded.push(item),
    readMetadata: () => { throw new Error('Manifest metadata must be reused'); },
  });
  assert.deepEqual(selected, entries.slice(-3));
  assert.equal(excluded.length, 9);
  assert.ok(excluded.every(({ reason }) => reason === 'ignored-folder'));
  assert.strictEqual(await selectMigrationEntries(entries, { source, ignoredFolders: [] }), entries);
});

it('propagates metadata failures instead of silently migrating excluded history', async () => {
  await assert.rejects(selectMigrationEntries([
    { key: `${source}/drafts/esp-dev/a.html` },
    { key: `${source}/.da-versions/ignored/v.html` },
  ], {
    source, ignoredFolders, readMetadata: async () => { throw new Error('Access denied'); },
  }), /Access denied/);
});

it('skips missing ignored current objects and still filters remaining version path hints', async () => {
  for (const original of [
    Object.assign(new Error('UnknownError'), { name: 'UnknownError', $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error('NotFound'), { name: 'NotFound' }),
    Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }),
    Object.assign(new Error('NoSuchKey'), { Code: 'NoSuchKey' }),
  ]) {
    const missingKey = `${source}/drafts/esp-stage/missing.html`;
    const entries = [
      { key: missingKey },
      { key: `${source}/keep.html`, metadata: { id: 'keep' } },
      { key: `${source}/.da-versions/missing/old.html`, metadata: { path: 'source/previous-location.html' } },
      { key: `${source}/.da-versions/missing/v.html`, metadata: { path: 'source/drafts/esp-stage/missing.html' } },
      { key: `${source}/.da-versions/missing/audit.txt`, metadata: {} },
      { key: `${source}/.da-versions/keep/v.html`, metadata: { path: 'source/keep.html' } },
    ];
    const excluded = [];
    const events = [];
    const selected = await selectMigrationEntries(entries, {
      source, ignoredFolders,
      readMetadata: async (key) => { assert.equal(key, missingKey); throw original; },
      onExcluded: (entry) => excluded.push(entry),
      onProgress: (event) => events.push(event),
    });
    assert.deepEqual(selected, [entries[1], entries[5]]);
    assert.deepEqual(excluded, [
      { key: missingKey, kind: 'doc', reason: 'ignored-folder', metadataStatus: 'not-found' },
      { key: entries[2].key, kind: 'version', reason: 'ignored-folder' },
      { key: entries[3].key, kind: 'version', reason: 'ignored-folder' },
      { key: entries[4].key, kind: 'audit', reason: 'ignored-folder' },
    ]);
    assert.ok(events.some(({ phase, key, status }) => phase === 'Skipping missing ignored source object'
      && key === missingKey && status === 'ignored-not-found'));
  }
});

it('does not suppress permission, service, or unresolved version metadata failures', async () => {
  for (const original of [
    Object.assign(new Error('Access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error('Service failed'), { name: 'UnknownError', $metadata: { httpStatusCode: 503 } }),
    Object.assign(new Error('Access denied'), { name: 'NotFound', $metadata: { httpStatusCode: 403 } }),
  ]) {
    await assert.rejects(selectMigrationEntries([
      { key: `${source}/drafts/esp-stage/a.html` },
      { key: `${source}/.da-versions/id/v.html` },
    ], {
      source, ignoredFolders, readMetadata: async () => { throw original; },
    }), (error) => error === original);
  }
  const missing = Object.assign(new Error('Missing unresolved version'), { $metadata: { httpStatusCode: 404 } });
  await assert.rejects(selectMigrationEntries([{ key: `${source}/.da-versions/unknown/v.html` }], {
    source, ignoredFolders, readMetadata: async () => { throw missing; },
  }), (error) => error === missing);
});

it('needs no metadata reads without history and supports explicit internal folder paths', async () => {
  const readMetadata = () => { throw new Error('No metadata requests expected'); };
  assert.deepEqual(await selectMigrationEntries([
    { key: `${source}/drafts/esp-dev/a.html` },
    { key: `${source}/drafts/esp-stage.props` },
  ], { source, ignoredFolders, readMetadata }), []);
  assert.deepEqual(await selectMigrationEntries([
    { key: `${source}/.da-versions/id/v.html` },
    { key: `${source}/.da-versions/id/audit.txt` },
  ], { source, ignoredFolders: ['/.da-versions'], readMetadata }), []);
});

it('skips ignored local bodies before reading them', async (t) => {
  await fs.mkdir('tmp', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('tmp/selection-dump-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entries = [
    { key: `${source}/drafts/esp-dev/a.html`, metadata: { id: 'ignored' }, bodyFile: 'missing.html' },
    { key: `${source}/.da-versions/ignored/v.html`, metadata: {}, bodyFile: 'missing-version.html' },
    { key: `${source}/keep.html`, metadata: {}, bodyFile: 'keep.html' },
  ];
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(entries));
  await fs.writeFile(path.join(directory, 'keep.html'), 'kept');
  const selected = await readDump(directory, {
    selectEntries: (listed) => selectMigrationEntries(listed, { source, ignoredFolders }),
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].body.toString(), 'kept');
});

for (const fullValidation of [false, true]) {
  it(`continues ${fullValidation ? 'full validation' : 'inventory'} when an ignored file vanishes after listing`, async (t) => {
    await fs.mkdir('tmp', { recursive: true });
    const directory = await fs.mkdtemp(path.resolve('tmp/selection-missing-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const envFile = path.join(directory, 'env');
    const out = path.join(directory, 'report.json');
    await fs.writeFile(envFile, '');
    const missingKey = `${source}/drafts/esp-stage/missing.html`;
    const da = fakeClient({
      [missingKey]: { body: 'missing after listing' },
      [`${source}/keep.html`]: { body: '<main>keep</main>', metadata: { id: 'keep' } },
      [`${source}/.da-versions/missing/v.html`]: { body: 'ignored', metadata: { path: 'source/drafts/esp-stage/missing.html' } },
    });
    const configs = fakeClient({
      'orgs/org/sites/source.json': { body: '{"content":{}}' },
      'orgs/org/sites/target.json': { body: '{"content":{}}' },
    });
    const requests = [];
    const messages = [];
    const report = await migrateCli([
      source, 'org/target', '-e', envFile, '-o', out,
      '--ignore-folder', '/drafts/esp-stage', ...(fullValidation ? ['--full-validation'] : []),
    ], {
      progress: {
        ...progress,
        log(message) { messages.push(message); },
        onProgress(event) { if (event.status === 'ignored-not-found') messages.push(event); },
      },
      createReadClient: (backend) => (backend === 'hlx6' ? configs : {
        async send(command) {
          requests.push({ operation: command.constructor.name, key: command.input.Key });
          if (command.constructor.name === 'HeadObjectCommand' && command.input.Key === missingKey) {
            throw Object.assign(new Error('UnknownError'), {
              name: 'NotFound', $metadata: { httpStatusCode: 404, attempts: 1 },
            });
          }
          return da.send(command);
        },
      }),
      tokenProvider: () => 'test',
      fetchImpl: async (url) => Response.json(url.startsWith('https://admin.da.live/') ? { data: [] } : {}),
    });
    if (report.sourceDump) t.after(() => fs.rm(report.sourceDump, { recursive: true, force: true }));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.sourceObjects, 1);
    assert.equal(report.storageError, undefined);
    assert.equal(report.excluded.find(({ key }) => key === missingKey).metadataStatus, 'not-found');
    assert.ok(messages.some((event) => event.status === 'ignored-not-found' && event.key === missingKey));
    assert.ok(messages.includes(`SKIPPED ignored-folder: ${missingKey}`));
    assert.deepEqual(requests.filter(({ operation }) => operation === 'GetObjectCommand').map(({ key }) => key),
      fullValidation ? [`${source}/keep.html`] : []);
    const saved = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.deepEqual(saved.blockers, []);
    assert.deepEqual(saved.excluded, report.excluded);
  });
}

for (const mode of ['inventory', 'full validation', 'execution']) {
  const execute = mode === 'execution';
  const fullValidation = mode !== 'inventory';
  it(`excludes live bodies and associated history in ${mode}`, async (t) => {
    await fs.mkdir('tmp', { recursive: true });
    const directory = await fs.mkdtemp(path.resolve('tmp/selection-cli-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const envFile = path.join(directory, 'env');
    const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    if (execute) {
      t.after(() => {
        for (const key of envKeys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      });
    }

    await fs.writeFile(envFile, execute ? 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n' : '');
    const da = fakeClient({
      [`${source}/keep.html`]: { body: '<main>keep</main>', metadata: { id: 'keep' } },
      [`${source}/drafts/esp-dev/a.html`]: { body: '<img src="https://excluded.example/image.png">', metadata: { id: 'ignored' } },
      [`${source}/drafts/esp-stage.props`]: { body: '{}', metadata: { id: 'folder' } },
      [`${source}/.da-versions/ignored/v.html`]: { body: 'ignored', metadata: { path: 'source/old.html' } },
      [`${source}/.da-versions/ignored/audit.txt`]: { body: 'ignored audit' },
      [`${source}/.da-versions/orphan/v.html`]: { body: 'orphan', metadata: { path: 'source/drafts/esp-dev/deleted.html' } },
      [`${source}/.da-versions/keep/v.html`]: { body: '<main>version</main>', metadata: { path: 'source/keep.html' } },
    });
    const configs = fakeClient({
      'orgs/org/sites/source.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
      'orgs/org/sites/target.json': { body: JSON.stringify({ content: { contentBusId: 'b'.repeat(59) } }) },
    });
    const requests = [];
    const writes = [];
    const report = await migrateCli([
      source, 'org/target', '-e', envFile, '-o', path.join(directory, 'report.json'),
      ...ignoredFolders.flatMap((folder) => ['--ignore-folder', folder]),
      ...(fullValidation ? ['--full-validation'] : []),
      ...(execute ? ['-x', '--refresh-source'] : []),
    ], {
      progress, tokenProvider: () => 'test',
      fetchImpl: async (url) => {
        assert.ok(!url.includes('excluded.example'));
        return Response.json(url.startsWith('https://admin.da.live/') ? { data: [] } : {});
      },
      createReadClient: (backend) => (backend === 'hlx6' ? configs : {
        send(command) {
          requests.push({ name: command.constructor.name, key: command.input.Key });
          return da.send(command);
        },
      }),
      createWriteClient: () => ({
        async send(command) {
          if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
          assert.equal(command.constructor.name, 'PutObjectCommand');
          writes.push(command.input.Key);
          return {};
        },
      }),
    });
    if (report.sourceDump) t.after(() => fs.rm(report.sourceDump, { recursive: true, force: true }));
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.ignoredFolders, ignoredFolders);
    assert.equal(report.sourceObjects, 2);
    assert.equal(report.excluded.filter(({ reason }) => reason === 'ignored-folder').length, 5);
    assert.equal(requests.filter(({ name }) => name === 'HeadObjectCommand').length, 4);
    assert.equal(report.folderExclusionMetadataReads, 4);
    const gets = requests.filter(({ name }) => name === 'GetObjectCommand').map(({ key }) => key).sort();
    assert.deepEqual(gets, fullValidation ? [`${source}/.da-versions/keep/v.html`, `${source}/keep.html`] : []);
    assert.equal(writes.length, execute ? 2 : 0);
    assert.ok(writes.every((key) => key === 'org/target/keep.html' || key.startsWith('org/target/.versions/')));
    if (fullValidation) {
      assert.equal(report.plannedObjects.length, 2);
      assert.deepEqual(report.imageUrls, []);
      const snapshot = JSON.parse(await fs.readFile(path.join(report.sourceDump, 'snapshot.json'), 'utf8'));
      assert.deepEqual(snapshot.ignoredFolders, ignoredFolders);
      assert.equal(snapshot.total, 2);
      const reused = await migrateCli([
        source, 'org/target', '-e', envFile, '-o', path.join(directory, 'reuse.json'),
        '--source-dump', report.sourceDump,
      ], { progress, createReadClient: () => configs });
      assert.match(reused.blockers[0], /snapshot omits folders.*--refresh-source/);
    } else {
      assert.equal(report.inventory.source.length, 2);
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')).excluded.length, 5);
  });
}
