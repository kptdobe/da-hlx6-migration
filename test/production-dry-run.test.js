import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOnlyClient, readOnlyFetch } from '../src/production-dry-run.js';
import { migrateCli } from '../src/migration-cli.js';
import { fakeClient } from './fixtures/fake-client.js';

it('requires a fresh source for execution on any site pair', () => {
  for (const flag of ['-x', '--execute']) {
    const result = spawnSync(process.execPath, ['bin/migrate.js', 'adobecom/da-events', 'kptdobe/da-events-migrated', flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Execution requires --refresh-source/);
    assert.equal(result.stdout, '');
  }
});

it('executes cross-org migrations with resolved bus IDs and target-only writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-execute-'));
  const envFile = path.join(directory, 'env');
  const roleArn = 'arn:aws:iam::123456789012:role/custom-migration';
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const da = fakeClient({
    'source-org/source-site/My Page.html': { body: '<main>event<img src="https://images.example/fail.png"></main>', metadata: { id: 'source-document' } },
    'source-org/source-site/unsupported.link': { body: 'linkdata' },
  });
  const configs = fakeClient({
    'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: {
      contentBusId: 'c'.repeat(59), fixedContentBusId: 'a'.repeat(59),
    } }) },
    'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
      contentBusId: 'd'.repeat(59), fixedContentBusId: 'b'.repeat(59),
      source: { url: 'https://content.da.live/target-org/target-site' },
    } }) },
  });
  const writes = [];
  const apiCalls = [];
  let scopedClientCreated = false;
  let downloadedSource;
  const messages = [];
  const progress = { summary() {}, log(message) { messages.push(message); }, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    const report = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '-x', '--refresh-source', '--role-arn', roleArn,
      '-e', envFile, '-o', path.join(directory, 'report.json'),
    ], {
      progress,
      createReadClient: (backend) => (backend === 'da' ? da : configs),
      createWriteClient: (scope, selectedRole) => {
        scopedClientCreated = true;
        assert.equal(selectedRole, roleArn);
        assert.equal(scope.org, 'target-org');
        assert.equal(scope.daOrg, 'source-org');
        assert.equal(scope.daSite, 'source-site');
        assert.equal(scope.hlx6Site, 'target-site');
        assert.equal(scope.daContentBusId, 'a'.repeat(59));
        assert.equal(scope.hlx6ContentBusId, 'b'.repeat(59));
        assert.deepEqual(scope.write, [{ bucket: 'helix-source-bus', prefix: 'target-org/target-site/' }]);
        assert.deepEqual(configs.calls.slice(0, 2), ['GetObjectCommand', 'GetObjectCommand']);
        assert.ok(configs.calls.slice(2).every((name) => name === 'ListObjectsV2Command'));
        return {
          async send(command) {
            assert.equal(command.input.Bucket, 'helix-source-bus');
            if (command.constructor.name === 'ListObjectsV2Command') {
              assert.equal(command.input.Prefix, 'target-org/target-site/');
              return { Contents: [] };
            }
            assert.equal(command.constructor.name, 'PutObjectCommand');
            assert.equal(command.input.Key, 'target-org/target-site/My Page.html');
            writes.push(command.input.Key);
            return {};
          },
        };
      },
      tokenProvider: () => 'test-token',
      fetchImpl: async (url, options = {}) => {
        apiCalls.push({ url, method: options.method || 'GET' });
        if (url === 'https://images.example/fail.png') return { ok: false, status: 403 };
        return { ok: true, json: async () => (url.startsWith('https://admin.da.live/')
          ? { data: [{ key: 'test', value: 'value' }] } : {}) };
      },
    });
    downloadedSource = report.sourceDump;
    assert.equal(scopedClientCreated, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.dryRun, false);
    assert.equal(report.objects, 1);
    assert.deepEqual(report.results, [{ key: 'target-org/target-site/My Page.html', status: 'written', kind: 'doc' }]);
    assert.deepEqual(report.excluded, [{
      key: 'source-org/source-site/unsupported.link', kind: 'media', reason: 'unsupported-extension',
    }]);
    assert.equal(report.warnings.find(({ id }) => id === 'unsupported-extensions').count, 1);
    assert.ok(messages.includes('SKIPPED unsupported-extension: source-org/source-site/unsupported.link'));
    assert.deepEqual(writes, ['target-org/target-site/My Page.html']);
    assert.equal(report.projectConfig.status, 'written');
    assert.deepEqual(apiCalls.map(({ method }) => method), ['GET', 'GET', 'GET', 'GET', 'GET', 'POST']);
    assert.equal(apiCalls[0].url, 'https://admin.da.live/config/source-org/source-site');
    assert.equal(apiCalls.at(-1).url, 'https://api.aem.live/target-org/sites/target-site/config/editor/da.json');
    assert.deepEqual(report.imageErrors, [{
      url: 'https://images.example/fail.png',
      error: 'Image fetch failed (403): https://images.example/fail.png',
      sourceKeys: ['source-org/source-site/My Page.html'], action: 'kept-original-url',
    }]);
    assert.equal(report.warnings.find(({ id }) => id === 'image-upload-errors').count, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')).imageErrors, report.imageErrors);
    assert.match(messages.at(-1), /Migration succeeded in/);
    assert.match(messages.at(-1), /1 object written.*0 overwritten, 1 newly created/);
    assert.match(messages.at(-1), /original URLs retained/);
    assert.match(messages.at(-1), /\.\/tmp\//);
  } finally {
    if (downloadedSource) await fs.rm(downloadedSource, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('uses the source content bus ID for both scopes when its fixed-ID flag is true', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-fixed-bus-'));
  const envFile = path.join(directory, 'env');
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    for (const [scenario, sourceFixed, sourceId, targetId] of [
      ['target-boolean', true, 'a'.repeat(59), 'b'.repeat(59)],
      ['missing-target-id', true, 'a'.repeat(59), undefined],
      ['invalid-source-id', true, '*', 'b'.repeat(59)],
      ['false-source-flag', false, 'a'.repeat(59), 'b'.repeat(59)],
    ]) {
      const configs = fakeClient({
        'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: {
          fixedContentBusId: sourceFixed, contentBusId: sourceId,
        } }) },
        'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
          fixedContentBusId: true, contentBusId: targetId,
        } }) },
      });
      let scopedClientCreated = false;
      const report = await migrateCli([
        'source-org/source-site', 'target-org/target-site', '-x', '--refresh-source',
        '-e', envFile, '-o', path.join(directory, `${scenario}.json`),
      ], {
        progress,
        createReadClient: (backend) => { assert.equal(backend, 'hlx6'); return configs; },
        createWriteClient: (scope) => {
          scopedClientCreated = true;
          assert.equal(scope.daContentBusId, sourceId);
          assert.equal(scope.hlx6ContentBusId, sourceFixed ? sourceId : targetId);
          throw new Error('Verified migration scope');
        },
        tokenProvider: () => { throw new Error('Unexpected API token'); },
      });
      assert.equal(scopedClientCreated, scenario !== 'invalid-source-id');
      assert.deepEqual(report.blockers, [
        scenario === 'invalid-source-id' ? 'Execution requires a valid target content bus ID' : 'Verified migration scope',
      ]);
      if (scopedClientCreated) {
        assert.equal(report.sourceContentBusId, sourceId);
        assert.equal(report.targetContentBusId, sourceFixed ? sourceId : targetId);
      }
    }
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('blocks invalid execution configs and roles before constructing a write client', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-scope-blockers-'));
  const envFile = path.join(directory, 'env');
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    for (const scenario of ['missing-source', 'invalid-source-id', 'invalid-target-id', 'invalid-role']) {
      const objects = {
        'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
          contentBusId: scenario === 'invalid-target-id' ? '*' : 'b'.repeat(59),
          source: { url: 'https://api.aem.live/target-org/sites/target-site/source' },
        } }) },
      };
      if (scenario !== 'missing-source') objects['orgs/source-org/sites/source-site.json'] = {
        body: JSON.stringify({ content: { contentBusId: scenario === 'invalid-source-id' ? '*' : 'a'.repeat(59) } }),
      };
      const configs = fakeClient(objects);
      const report = await migrateCli([
        'source-org/source-site', 'target-org/target-site', '-x', '--refresh-source',
        '--role-arn', scenario === 'invalid-role' ? 'not-an-arn' : 'arn:aws:iam::123456789012:role/migration',
        '-e', envFile, '-o', path.join(directory, `${scenario}.json`),
      ], {
        progress,
        createReadClient: (backend) => { assert.equal(backend, 'hlx6'); return configs; },
        createWriteClient: () => { throw new Error('Unexpected write client'); },
        tokenProvider: () => { throw new Error('Unexpected API token'); },
      });
      assert.equal(report.blockers.length, 1);
      const expected = {
        'missing-source': /Execution requires a readable source site config/,
        'invalid-source-id': /Invalid daContentBusId/,
        'invalid-target-id': /valid target content bus ID/,
        'invalid-role': /valid IAM migration role ARN/,
      };
      assert.match(report.blockers[0], expected[scenario]);
      assert.equal(report.results, undefined);
      assert.ok(configs.calls.every((name) => ['GetObjectCommand', 'ListObjectsV2Command'].includes(name)));
    }
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('retains completed write and image counts in the report and final summary after a later write failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-partial-summary-'));
  const envFile = path.join(directory, 'env');
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const imageUrl = 'https://content.da.live/source-org/source-site/image.png';
  const da = fakeClient({
    'source-org/source-site/a.html': { body: `<main><img src="${imageUrl}"></main>`, metadata: { id: 'a' } },
    'source-org/source-site/b.html': { body: '<main>later</main>', metadata: { id: 'b' } },
  });
  const configs = fakeClient({
    'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
    'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
      contentBusId: 'b'.repeat(59), source: { url: 'https://api.aem.live/target-org/sites/target-site/source' },
    } }) },
  });
  const messages = [];
  const progress = { summary() {}, log(message) { messages.push(message); }, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  let downloadedSource;
  try {
    const report = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '-x', '--refresh-source',
      '-e', envFile, '-o', path.join(directory, 'report.json'),
    ], {
      progress, createReadClient: (backend) => (backend === 'da' ? da : configs), tokenProvider: () => 'test-token',
      createWriteClient: () => ({ async send(command) {
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
        if (command.input.Key.endsWith('/b.html')) throw new Error('Storage unavailable');
        return {};
      } }),
      fetchImpl: async (url, options = {}) => {
        if (url.startsWith('https://admin.da.live/')) return { status: 404 };
        if (options.method === 'POST') return { ok: true, json: async () => ({ uri: 'https://main--target-site--target-org.aem.page/media_a.png' }) };
        assert.equal(url, imageUrl);
        return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    downloadedSource = report.sourceDump;
    assert.deepEqual(report.blockers, ['Storage unavailable']);
    assert.deepEqual(report.uploadedImageUrls, [imageUrl]);
    assert.equal(report.results.filter(({ status }) => status === 'written').length, 1);
    assert.match(messages.at(-1), /Migration blocked after/);
    assert.match(messages.at(-1), /1 object written.*0 overwritten, 1 newly created/);
    assert.match(messages.at(-1), /1 image uploaded/);
    assert.doesNotMatch(messages.at(-1), /Migration succeeded/);
  } finally {
    if (downloadedSource) await fs.rm(downloadedSource, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
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

it('requires explicit overwrite for any target-prefix object before downloading or assuming a write role', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-existing-target-'));
  const envFile = path.join(directory, 'env');
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  const snapshots = [];
  try {
    for (const [scenario, key] of [
      ['doc', 'target-org/target-site/index.html'],
      ['marker', 'target-org/target-site/'],
      ['version', 'target-org/target-site/.versions/id/audit.txt'],
      ['neighbor', 'target-org/target-site-other/index.html'],
    ]) {
      for (const overwrite of [false, true]) {
        const da = fakeClient({
          'source-org/source-site/index.html': { body: '<main>source</main>', metadata: { id: 'source-id' } },
        });
        const configs = fakeClient({
          'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
          'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: {
            contentBusId: 'b'.repeat(59), source: { url: 'https://content.da.live/target-org/target-site' },
          } }) },
          [key]: { body: '' },
        });
        let writeClientCreated = false;
        const report = await migrateCli([
          'source-org/source-site', 'target-org/target-site', '-x', '--refresh-source',
          ...(overwrite ? ['--overwrite'] : []), '-e', envFile,
          '-o', path.join(directory, `${scenario}-${overwrite}.json`),
        ], {
          progress,
          createReadClient: (backend) => (backend === 'da' ? da : configs),
          createWriteClient: () => { writeClientCreated = true; return configs; },
          tokenProvider: () => { throw new Error('Reached full validation'); },
        });
        if (report.sourceDump) snapshots.push(report.sourceDump);
        const blocked = scenario !== 'neighbor' && !overwrite;
        assert.equal(writeClientCreated, !blocked);
        assert.equal(report.targetObjects, scenario === 'neighbor' ? 0 : 1);
        assert.equal(report.warnings.some(({ id }) => id === 'target-exists'), scenario !== 'neighbor');
        if (blocked) {
          assert.match(report.blockers[0], /execution requires --overwrite/);
          assert.deepEqual(da.calls, []);
          assert.equal(report.sourceDump, undefined);
        } else {
          assert.deepEqual(report.blockers, ['Reached full validation']);
          assert.ok(da.calls.includes('GetObjectCommand'));
        }
        assert.ok(configs.calls.every((name) => ['GetObjectCommand', 'ListObjectsV2Command'].includes(name)));
      }
    }
  } finally {
    for (const snapshot of snapshots) await fs.rm(snapshot, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('warns about same-site target objects regardless of source URL or bus ID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-da-target-'));
  const envFile = path.join(directory, 'env');
  const site = 'cat-digital-platform/catdealer';
  await fs.writeFile(envFile, '');
  try {
    for (const [scenario, contentBusId] of [
      ['valid-id', 'a'.repeat(59)], ['missing-id', undefined], ['invalid-id', '*'],
    ]) {
      const messages = [];
      const progress = { summary() {}, log(message) { messages.push(message); }, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
      const da = fakeClient({
        [`${site}/index.html`]: { body: 'source' },
        [`${site}/unsupported.link`]: { body: 'link' },
      });
      const hlx = fakeClient({
        'orgs/cat-digital-platform/sites/catdealer.json': { body: JSON.stringify({ content: {
          contentBusId, source: { url: `https://content.da.live/${site}` },
        } }) },
        [`${site}/index.html`]: { body: 'target' },
      });
      const dependencies = {
        progress,
        createReadClient: (backend) => ({
          async send(command) {
            assert.ok(command.constructor.name === 'ListObjectsV2Command'
              || (command.constructor.name === 'GetObjectCommand' && command.input.Bucket === 'helix-config-bus'));
            return (backend === 'da' ? da : hlx).send(command);
          },
        }),
        tokenProvider: () => { throw new Error('Unexpected API token'); },
        createWriteClient: () => { throw new Error('Unexpected write client'); },
        fetchImpl: () => { throw new Error('Unexpected API request'); },
      };
      const out = path.join(directory, `${scenario}.json`);
      const report = await migrateCli([site, site, '--dry-run', '-e', envFile, '-o', out], dependencies);
      assert.deepEqual(report.blockers, []);
      assert.equal(report.sourceObjects, 2);
      assert.equal(report.targetObjects, 1);
      assert.equal(report.sourceBytes, 10);
      assert.equal(report.targetBytes, 6);
      assert.equal(report.targetContentBusId, scenario === 'valid-id' ? contentBusId : undefined);
      assert.equal(report.warnings.find(({ id }) => id === 'target-exists').count, 1);
      assert.equal(report.warnings.find(({ id }) => id === 'unsupported-extensions').count, 1);
      assert.ok(messages.some((message) => message.startsWith('Warning: HLX6 target contains objects')));
      assert.ok(messages.some((message) => message.includes(`sourceUrl=https://content.da.live/${site}`)));
      assert.ok(messages.some((message) => message.includes(`contentBusId=${scenario === 'valid-id' ? contentBusId : 'unknown (missing or invalid)'}`)));
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')).warnings, report.warnings);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
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
  const originalCwd = process.cwd();
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
  let downloadedSource;
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    process.chdir(directory);
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
    downloadedSource = report.sourceDump;
    assert.equal(path.dirname(downloadedSource), path.resolve('tmp'));
    assert.equal(report.sourceSnapshotComplete, true);
    assert.equal(await fs.readFile(path.join(downloadedSource, 'files/index.html'), 'utf8'), '<body><main>Event</main></body>');
    assert.equal((await fs.stat(downloadedSource)).mode & 0o777, 0o700);
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
    process.chdir(originalCwd);
    if (downloadedSource) await fs.rm(downloadedSource, { recursive: true, force: true });
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

it('records source-scope blockers independently of the target source URL', async () => {
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
      assert.match(report.blockers[0], /outside the requested DA site/);
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')).blockers, report.blockers);
      assert.ok(client.calls.every((name) => ['GetObjectCommand', 'ListObjectsV2Command'].includes(name)));
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