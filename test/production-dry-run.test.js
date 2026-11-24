import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOnlyClient, readOnlyFetch } from '../src/production-dry-run.js';
import { migrateCli } from '../src/migration-cli.js';
import { fakeClient } from './fixtures/fake-client.js';
import { scanSite } from '../src/dump.js';
import { mediaHash } from '../src/media.js';

it('requires a fresh source or explicit snapshot resume for execution on any site pair', () => {
  for (const flag of ['-x', '--execute']) {
    const result = spawnSync(process.execPath, ['bin/migrate.js', 'adobecom/da-events', 'kptdobe/da-events-migrated', flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Execution requires --refresh-source/);
    assert.equal(result.stdout, '');
  }
});

it('rejects invalid resume option combinations before creating a report', async () => {
  for (const flags of [
    ['--resume'],
    ['--resume', '--execute'],
    ['--resume', '--source-dump', 'unused'],
    ['--resume', '--execute', '--source-dump', 'unused', '--refresh-source'],
  ]) {
    await assert.rejects(migrateCli(['org/site', 'org/target', ...flags]), /--resume requires/);
  }
});

it('logs skipped audit records and persists their original lines in the private full-validation report', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-audit-'));
  const dump = path.join(directory, 'dump');
  const envFile = path.join(directory, 'env');
  const out = path.join(directory, 'report.json');
  const key = 'source-org/source-site/.da-versions/id/audit.txt';
  const invalid = 'not-a-timestamp\t[{"email":"author@example.com"}]\t/private.html';
  const messages = [];
  try {
    await fs.writeFile(envFile, '');
    await scanSite({
      client: fakeClient({
        'source-org/source-site/index.html': { body: '<main/>', metadata: { id: 'id' } },
        [key]: { body: `1000\t[]\t/index.html\n${invalid}\n2000\t[]\t/index.html\n` },
        'source-org/source-site/.da-versions/id/audit-500.txt': { body: '500\t[]\t/old.html\n' },
      }),
      backend: 'da', bucket: 'aem-content', org: 'source-org', site: 'source-site', outDir: dump,
    });
    const hlx = fakeClient({
      'orgs/source-org/sites/source-site.json': { body: '{"content":{}}' },
      'orgs/target-org/sites/target-site.json': { body: '{"content":{}}' },
    });
    const report = await migrateCli([
      'source-org/source-site', 'target-org/target-site', '--full-validation',
      '--source-dump', dump, '-e', envFile, '-o', out,
    ], {
      createReadClient: () => hlx,
      createWriteClient: () => { throw new Error('Dry run must not create a writer'); },
      tokenProvider: () => 'test-token',
      fetchImpl: async () => ({ status: 404 }),
      progress: {
        summary() {}, log(message) { messages.push(message); }, onProgress() {}, close() {},
        async run(label, operation) { return operation(); },
      },
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.plannedObjects.filter(({ kind }) => kind === 'audit').length, 2);
    const warning = report.warnings.find(({ id }) => id === 'malformed-audit-records');
    assert.deepEqual(warning.items, [{
      key, line: 2, record: invalid, error: 'invalid timestamp', action: 'skipped-record',
    }]);
    assert.ok(messages.some((message) => message === `SKIPPED malformed-audit-record: ${key}:2: invalid timestamp`));
    assert.ok(messages.every((message) => !message.includes(invalid)));
    const saved = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.deepEqual(saved.warnings, report.warnings);
    assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('resumes complete snapshots only when live source inventory still matches, without source downloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-resume-'));
  const dump = path.join(directory, 'dump');
  const envFile = path.join(directory, 'env');
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const sourceKey = 'source-org/source-site/index.html';
  const sourceObjects = { [sourceKey]: { body: '<main>source</main>', metadata: { id: 'source-id' } } };
  await scanSite({
    client: fakeClient(sourceObjects), backend: 'da', bucket: 'aem-content',
    org: 'source-org', site: 'source-site', outDir: dump,
  });
  const progress = { summary() {}, log() {}, onProgress() {}, close() {}, async run(label, operation) { return operation(); } };
  try {
    for (const scenario of ['match', 'precision', 'etag', 'size', 'modified', 'modified-second', 'added', 'missing', 'duplicate', 'wrong-source', 'authentication', 'nonempty-target']) {
      const liveObjects = scenario === 'missing' ? {
        'source-org/source-site/other.html': { body: 'other' },
      } : {
        ...sourceObjects,
        ...(scenario === 'added' && { 'source-org/source-site/added.html': { body: 'new' } }),
      };
      const da = fakeClient(liveObjects);
      const configs = fakeClient({
        'orgs/source-org/sites/source-site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
        'orgs/target-org/sites/target-site.json': { body: JSON.stringify({ content: { contentBusId: 'b'.repeat(59) } }) },
        ...(scenario === 'nonempty-target' && { 'target-org/target-site/index.html': { body: 'existing' } }),
      });
      const savedManifest = await fs.readFile(path.join(dump, 'manifest.json'), 'utf8');
      const savedMarker = await fs.readFile(path.join(dump, 'snapshot.json'), 'utf8');
      if (scenario === 'duplicate' || scenario === 'wrong-source') {
        const manifest = JSON.parse(savedManifest);
        if (scenario === 'duplicate') manifest.push({ ...manifest[0] });
        else manifest[0].key = 'wrong-org/wrong-site/index.html';
        await fs.writeFile(path.join(dump, 'manifest.json'), JSON.stringify(manifest));
        await fs.writeFile(path.join(dump, 'snapshot.json'), JSON.stringify({ complete: true, downloaded: manifest.length, total: manifest.length }));
      }
      const writes = [];
      const apiCalls = [];
      let authenticated = false;
      try {
        const report = await migrateCli([
          'source-org/source-site', 'target-org/target-site', '--execute', '--resume',
          '--source-dump', dump, '-e', envFile, '-o', path.join(directory, `${scenario}.json`),
        ], {
          progress,
          createReadClient: (backend) => {
            if (backend !== 'da') return configs;
            assert.equal(authenticated, true);
            return { async send(command) {
              assert.equal(command.constructor.name, 'ListObjectsV2Command');
              const response = await da.send(command);
              for (const entry of response.Contents) {
                if (scenario === 'etag') entry.ETag = '"changed-etag"';
                if (scenario === 'size') entry.Size += 1;
                if (scenario === 'modified') entry.LastModified = new Date('2026-02-01');
                if (scenario === 'modified-second') entry.LastModified = new Date('2026-01-01T00:00:01.000Z');
                if (scenario === 'precision') entry.LastModified = new Date('2026-01-01T00:00:00.895Z');
              }
              return response;
            } };
          },
          createWriteClient: () => ({ async send(command) {
            if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
            assert.equal(command.constructor.name, 'PutObjectCommand');
            assert.equal(command.input.IfNoneMatch, '*');
            writes.push(command.input.Key);
            return {};
          } }),
          tokenProvider: () => {
            if (scenario === 'authentication') throw new Error('DA login unavailable');
            authenticated = true;
            return 'test-token';
          },
          fetchImpl: async (url, options = {}) => {
            apiCalls.push({ url, method: options.method || 'GET' });
            return { status: 404 };
          },
        });
        assert.equal(report.resume, true);
        if (scenario === 'match' || scenario === 'precision') {
          assert.deepEqual(report.blockers, []);
          assert.equal(report.sourceSnapshotComplete, true);
          assert.equal(report.sourceInventoryVerified, true);
          assert.equal(report.sourceDump, dump);
          assert.equal(report.sourceObjects, 1);
          assert.deepEqual(writes, ['target-org/target-site/index.html']);
        } else {
          assert.equal(report.blockers.length, 1);
          const expected = {
            authentication: /DA login unavailable/,
            'nonempty-target': /requires --overwrite/,
            'wrong-source': /outside the requested DA site/,
          }[scenario] || /Source inventory does not match.*--refresh-source/;
          assert.match(report.blockers[0], expected);
          assert.deepEqual(writes, []);
          assert.deepEqual(apiCalls, []);
          if (['authentication', 'nonempty-target'].includes(scenario)) assert.deepEqual(da.calls, []);
        }
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${scenario}.json`), 'utf8')).blockers, report.blockers);
      } finally {
        await fs.writeFile(path.join(dump, 'manifest.json'), savedManifest);
        await fs.writeFile(path.join(dump, 'snapshot.json'), savedMarker);
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

it('explains expired AWS credentials in progress and saved reports without mislabeling other errors', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-expired-aws-'));
  const envFile = path.join(directory, 'env');
  const envKeys = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const [scenario, credentials, backend, error, shouldExplain] of [
      ['profile', 'AWS_PROFILE=test-profile\n', 'hlx6', Object.assign(new Error('The provided token has expired.'), { name: 'ExpiredToken' }), true],
      ['environment', 'AWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\nAWS_SESSION_TOKEN=test-token\n', 'hlx6',
        Object.assign(new Error('The provided token has expired.'), { code: 'ExpiredTokenException' }), true],
      ['other-aws-error', 'AWS_PROFILE=test-profile\n', 'hlx6', Object.assign(new Error('Access denied'), { name: 'AccessDenied' }), false],
      ['r2-error', 'AWS_PROFILE=test-profile\n', 'da', Object.assign(new Error('The provided token has expired.'), { name: 'ExpiredToken' }), false],
      ['untyped-error', 'AWS_PROFILE=test-profile\n', 'hlx6', new Error('The provided token has expired.'), false],
    ]) {
      await fs.writeFile(envFile, credentials);
      const out = path.join(directory, `${scenario}.json`);
      const messages = [];
      const config = fakeClient({
        'orgs/org/sites/site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
      });
      const report = await migrateCli(['org/site', 'org/site', '-e', envFile, '-o', out], {
        createReadClient: (requestedBackend) => (requestedBackend === backend
          ? { async send() { throw error; } } : config),
        tokenProvider: () => { throw new Error('Inventory must not request DA authentication'); },
        progress: {
          summary() {}, onProgress() {}, close() {},
          log(message) { messages.push(message); },
          async run(label, operation) { return operation(); },
        },
      });
      assert.equal(report.blockers.length, 1);
      const [blocker] = report.blockers;
      if (shouldExplain) {
        assert.match(blocker, /AWS storage credentials have expired/);
        assert.match(blocker, /Use "Sign in with AWS \/ KLAM" in the UI, or retry the CLI to authenticate/);
        assert.match(blocker, /not your DA login/);
        assert.match(blocker, /"Sign in with DA" does not refresh them/);
        assert.match(blocker, scenario === 'profile' ? /profile "test-profile".*~\/\.aws\/credentials/ : /AWS environment variables/);
        assert.ok(!blocker.includes('test-key') && !blocker.includes('test-secret') && !blocker.includes('test-token'));
      } else {
        assert.ok(blocker.includes(error.message));
      }
      assert.equal(report.storageError.operation, backend === 'hlx6' ? 'GetObject' : 'ListObjectsV2');
      assert.ok(messages.includes(`Blocked: ${blocker}`));
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')).blockers, report.blockers);
    }
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('logs and saves the exact ignored-folder HEAD failure instead of only UnknownError', async (t) => {
  await fs.mkdir('tmp', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('tmp/migration-storage-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, 'env');
  const out = path.join(directory, 'report.json');
  await fs.writeFile(envFile, '');
  const key = 'org/source/drafts/esp-stage/page.html';
  const da = fakeClient({
    [key]: { body: 'ignored', metadata: { id: 'ignored' } },
    'org/source/.da-versions/ignored/version.html': { body: 'old' },
  });
  const configs = fakeClient({
    'orgs/org/sites/source.json': { body: '{"content":{}}' },
    'orgs/org/sites/target.json': { body: '{"content":{}}' },
  });
  const messages = [];
  const report = await migrateCli([
    'org/source', 'org/target', '--ignore-folder', '/drafts/esp-stage', '-e', envFile, '-o', out,
  ], {
    progress: {
      summary() {}, onProgress() {}, close() {},
      log(message) { messages.push(message); },
      async run(label, action) { return action(); },
    },
    createReadClient: (backend) => (backend === 'hlx6' ? configs : {
      async send(command) {
        if (command.constructor.name === 'HeadObjectCommand') {
          assert.equal(command.input.Key, key);
          throw Object.assign(new Error('UnknownError'), {
            name: 'UnknownError', $metadata: { httpStatusCode: 503, attempts: 5, requestId: 'r2-request' },
            'Token-0': 'private-token',
            $response: { body: 'private-body', headers: { 'cf-ray': 'r2-ray', authorization: 'private-auth' } },
          });
        }
        return da.send(command);
      },
    }),
    tokenProvider: () => { throw new Error('Inventory must not authenticate with DA'); },
  });
  assert.equal(report.blockers.length, 1);
  const [blocker] = report.blockers;
  assert.ok(blocker.includes(`HeadObject failed for "s3://aem-content/${key}"`));
  assert.match(blocker, /UnknownError; HTTP 503 Service Unavailable/);
  assert.match(blocker, /attempts=5/);
  assert.match(blocker, /requestId="r2-request"/);
  assert.match(blocker, /cfRay="r2-ray"/);
  assert.ok(messages.includes(`Blocked: ${blocker}`));
  assert.deepEqual(report.storageError, {
    operation: 'HeadObject', bucket: 'aem-content', key, serviceCode: 'UnknownError',
    httpStatusCode: 503, attempts: 5, requestId: 'r2-request', cfRay: 'r2-ray',
  });
  const saved = await fs.readFile(out, 'utf8');
  assert.deepEqual(JSON.parse(saved).storageError, report.storageError);
  assert.deepEqual(JSON.parse(saved).blockers, report.blockers);
  assert.doesNotMatch(saved, /private-token|private-body|private-auth/);
});

it('executes cross-org migrations with resolved bus IDs and target-only writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-execute-'));
  const envFile = path.join(directory, 'env');
  const roleArn = 'arn:aws:iam::123456789012:role/custom-migration';
  const envKeys = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_DEF_URL'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  await fs.writeFile(envFile, 'S3_ACCESS_KEY_ID=test\nS3_SECRET_ACCESS_KEY=test\nS3_DEF_URL=https://example.com\n');
  const sourceUrl = 'https://content.da.live/source-org/source-site/library/blocks/columns';
  const targetUrl = 'https://api.aem.live/target-org/sites/target-site/source/library/blocks/columns.html';
  const unsupportedUrl = 'https://admin.da.live/copy/source-org/source-site/page.html';
  const da = fakeClient({
    'source-org/source-site/My Page.html': { body: `<main><a href="${sourceUrl}">event</a><a href="${unsupportedUrl}">legacy</a><img src="https://images.example/fail.png"></main>`, metadata: { id: 'source-document' } },
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
  const awsAuth = { credentials: async () => { throw new Error('Fake storage must not resolve AWS credentials'); } };
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
      awsAuth,
      createReadClient: (backend, options) => {
        if (backend === 'hlx6') assert.equal(options.credentials, awsAuth.credentials);
        return backend === 'da' ? da : configs;
      },
      createWriteClient: (scope, selectedRole, region, options) => {
        scopedClientCreated = true;
        assert.equal(region, 'us-east-1');
        assert.equal(options.credentials, awsAuth.credentials);
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
            assert.ok(gunzipSync(command.input.Body).toString().includes(`href="${targetUrl}"`));
            assert.ok(gunzipSync(command.input.Body).toString().includes(`href="${unsupportedUrl}"`));
            writes.push(command.input.Key);
            return {};
          },
        };
      },
      tokenProvider: () => 'test-token',
      fetchImpl: async (url, options = {}) => {
        apiCalls.push({ url, method: options.method || 'GET' });
        if (url === 'https://images.example/fail.png') return { ok: false, status: 403 };
        if (options.method === 'POST') {
          assert.deepEqual(JSON.parse(options.body), { data: [
            { key: 'test', value: targetUrl }, { key: 'legacy', value: unsupportedUrl },
          ] });
        }
        return { ok: true, json: async () => (url.startsWith('https://admin.da.live/')
          ? { data: [{ key: 'test', value: sourceUrl }, { key: 'legacy', value: unsupportedUrl }] } : {}) };
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
    assert.deepEqual(report.urlRewrites, [{ key: 'source-org/source-site/My Page.html', url: sourceUrl, targetUrl }]);
    assert.deepEqual(report.projectConfig.urlRewrites, [{ url: sourceUrl, targetUrl }]);
    assert.equal(report.warnings.find(({ id }) => id === 'unrewritten-da-urls').count, 1);
    assert.equal(report.warnings.find(({ id }) => id === 'unrewritten-da-config-urls').count, 1);
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
    assert.match(messages.at(-1), /2 DA URL rewrites.*applied/);
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
  const reusedUrl = 'https://images.example/existing.png';
  const reusedBody = Buffer.from([2]);
  const da = fakeClient({
    'source-org/source-site/a.html': { body: `<main><img src="${imageUrl}"><img src="${reusedUrl}"></main>`, metadata: { id: 'a' } },
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
        if (command.constructor.name === 'HeadObjectCommand') {
          if (command.input.Key === `${'b'.repeat(59)}/${mediaHash(reusedBody)}`) {
            return { ContentType: 'image/png', ContentLength: reusedBody.length };
          }
          throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
        }
        if (command.input.Key.endsWith('/b.html')) throw new Error('Storage unavailable');
        return {};
      } }),
      fetchImpl: async (url, options = {}) => {
        if (url.startsWith('https://admin.da.live/')) return { status: 404 };
        if (options.method === 'POST') return { ok: true, json: async () => ({ uri: 'https://main--target-site--target-org.aem.page/media_a.png' }) };
        if (url === reusedUrl) return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => reusedBody };
        assert.equal(url, imageUrl);
        return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    downloadedSource = report.sourceDump;
    assert.equal(report.blockers.length, 1);
    assert.match(report.blockers[0], /PutObject failed.*target-org\/target-site\/b\.html.*Storage unavailable/);
    assert.equal(report.storageError.operation, 'PutObject');
    assert.deepEqual(report.uploadedImageUrls, [imageUrl]);
    assert.deepEqual(report.reusedImageUrls, [reusedUrl]);
    assert.equal(report.results.filter(({ status }) => status === 'written').length, 1);
    assert.match(messages.at(-1), /Migration blocked after/);
    assert.match(messages.at(-1), /1 object written.*0 overwritten, 1 newly created/);
    assert.match(messages.at(-1), /1 image uploaded/);
    assert.match(messages.at(-1), /1 image reused/);
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
          assert.deepEqual(da.calls, []);
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
    assert.equal(report.targetFiles, 0);
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