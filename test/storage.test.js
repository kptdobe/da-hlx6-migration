import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDevVars, applyDevVars, listAll, listSharded, getObject, headObject, createClient, putObject,
} from '../src/storage.js';
import { createScope } from '../src/scope.js';
import { fakeClient } from './fixtures/fake-client.js';
import { generateShardPrefixes } from '../src/sharding.js';

describe('generateShardPrefixes', () => {
  it('retains da-magic character shards and expands version paths into 256 hex shards', () => {
    const shards = generateShardPrefixes('org/site/', 8, { expandPaths: ['.da-versions/'] });
    const hex = shards.filter((shard) => shard.type === 'hex');
    assert.equal(hex.length, 256);
    assert.equal(hex[0].prefix, 'org/site/.da-versions/00');
    assert.equal(hex.at(-1).prefix, 'org/site/.da-versions/ff');
    assert.ok(shards.some((shard) => shard.prefix === 'org/site/a'));
    assert.ok(shards.some((shard) => shard.prefix === 'org/site/@'));
    assert.equal(new Set(shards.map((shard) => shard.prefix)).size, shards.length);
    assert.deepEqual(generateShardPrefixes('org/site/', 1), [
      { prefix: 'org/site/', type: 'all', description: 'All files', charRange: null },
    ]);
  });
});

describe('listSharded', () => {
  it('rejects invalid concurrency before sending requests', async () => {
    const client = fakeClient({});
    for (const concurrency of [0, -1, 1.5, 33, NaN]) {
      await assert.rejects(listSharded(client, 'aem-content', 'org/site/', { concurrency }), /concurrency/);
    }
    assert.deepEqual(client.calls, []);
  });
  it('lists every site key once across pages, punctuation, boundaries, and version shards', async () => {
    const prefix = 'org/site/';
    const suffixes = ['', '0', '0.html', 'A', 'a', 'a/page.html', '.da/comments/id/thread',
      '.da-versions/00/id', '.da-versions/01/id', '.da-versions/ff/id',
      '.da-versions/other/id', '!special', 'z', '~last', '\u00e9/page.html'];
    const keys = suffixes.map((suffix) => prefix + suffix);
    const client = fakeClient(Object.fromEntries([...keys, 'org/other/index.html']
      .map((key) => [key, { body: 'content' }])), 2);
    const events = [];
    const objects = await listSharded(client, 'aem-content', prefix, {
      concurrency: 3, onProgress: (event) => events.push(event),
    });
    assert.deepEqual(objects.map((object) => object.key),
      keys.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
    assert.equal(new Set(objects.map((object) => object.key)).size, keys.length);
    assert.equal(events.at(-1).completed, keys.length);
    assert.equal(events.at(-1).total, keys.length);
    assert.ok(events.every((event) => event.shardsTotal === events[0].shardsTotal));
    assert.equal(events.at(-1).shardsCompleted, events[0].shardsTotal);
    assert.ok(client.calls.every((name) => name === 'ListObjectsV2Command'));
  });

  it('bounds simultaneous read requests and uses parallel shards', async () => {
    let active = 0;
    let maximum = 0;
    const client = {
      async send() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { Contents: [], IsTruncated: false };
      },
    };
    assert.deepEqual(await listSharded(client, 'aem-content', 'org/site/', { concurrency: 3 }), []);
    assert.equal(maximum, 3);
  });
});

describe('parseDevVars', () => {
  it('reads KEY=VALUE lines, skipping comments and blanks', () => {
    const vars = parseDevVars('# R2 token\nS3_ACCESS_KEY_ID=abc\n\nS3_DEF_URL=https://x.r2.cloudflarestorage.com\n');
    assert.deepEqual(vars, { S3_ACCESS_KEY_ID: 'abc', S3_DEF_URL: 'https://x.r2.cloudflarestorage.com' });
  });
  it('keeps "=" inside values and strips surrounding quotes', () => {
    assert.deepEqual(parseDevVars('SECRET="a=b=c"'), { SECRET: 'a=b=c' });
  });
});

describe('applyDevVars', () => {
  it('loads file values over shell values and selects the configured AWS profile', () => {
    const env = {
      AWS_REGION: 'eu-west-1',
      AWS_PROFILE: 'ambient-profile',
      AWS_ACCESS_KEY_ID: 'ambient-key',
      AWS_SECRET_ACCESS_KEY: 'ambient-secret',
      AWS_SESSION_TOKEN: 'ambient-token',
    };
    applyDevVars('AWS_REGION=us-east-1\nDA_CONFIG_TOKEN=local-token\nEMPTY=\n', env);
    assert.equal(env.AWS_REGION, 'us-east-1');
    assert.equal(env.AWS_PROFILE, 'ambient-profile');
    assert.equal(env.AWS_ACCESS_KEY_ID, 'ambient-key');
    assert.equal(env.DA_CONFIG_TOKEN, 'local-token');
    applyDevVars('AWS_PROFILE=default\n', env);
    assert.equal(env.AWS_PROFILE, 'default');
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
  });
  it('selects static AWS keys instead of an ambient profile when the file provides keys', () => {
    const env = { AWS_PROFILE: 'ambient-profile' };
    applyDevVars('AWS_ACCESS_KEY_ID=file-key\nAWS_SECRET_ACCESS_KEY=file-secret\nAWS_SESSION_TOKEN=file-token\n', env);
    assert.equal(env.AWS_PROFILE, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, 'file-key');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'file-secret');
  });
});

describe('createClient', () => {
  it('enables SDK adaptive throttling when explicitly requested', async () => {
    const client = createClient('hlx6', { retryMode: 'adaptive' });
    assert.equal(client.config.retryMode, 'adaptive');
    client.destroy();
  });
  it('fails clearly when R2 credentials are missing', () => {
    assert.throws(() => createClient('da', { devVarsPath: '/nonexistent/.dev.vars' }), /R2 credentials not found/);
  });
  it('rejects unknown backends', () => {
    assert.throws(() => createClient('gcs'), /Unknown backend/);
  });
});

describe('listAll', () => {
  it('returns every object under the prefix across pages', async () => {
    const objects = {};
    for (let i = 0; i < 5; i += 1) objects[`org/site/doc${i}.html`] = { body: `<p>${i}</p>` };
    objects['org/other/x.html'] = { body: 'x' };
    const client = fakeClient(objects, 2);
    const list = await listAll(client, 'bucket', 'org/site/');
    assert.deepEqual(list.map((o) => o.key), ['org/site/doc0.html', 'org/site/doc1.html', 'org/site/doc2.html', 'org/site/doc3.html', 'org/site/doc4.html']);
    assert.equal(client.calls.filter((c) => c === 'ListObjectsV2Command').length, 3);
  });
});

describe('putObject', () => {
  const scope = createScope({
    org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6-migrated', daContentBusId: 'a'.repeat(59), hlx6ContentBusId: 'b'.repeat(59),
  });
  it('never sends a write outside the scope to S3', async () => {
    const sent = [];
    const client = { send: async (cmd) => sent.push(cmd) };
    await assert.rejects(putObject(client, scope, { Bucket: 'helix-source-bus', Key: 'kptdobe/sample-content-hlx6/a.html', Body: 'x' }), /Write refused/);
    assert.equal(sent.length, 0);
    await putObject(client, scope, { Bucket: 'helix-source-bus', Key: 'kptdobe/sample-content-hlx6-migrated/a.html', Body: 'x' });
    assert.equal(sent.length, 1);
  });
});

describe('getObject / headObject', () => {
  const client = fakeClient({
    'o/s/plain.html': { body: '<main>plain</main>', metadata: { id: 'u1' } },
    'o/s/zipped.html': { body: '<main>zipped</main>', gzip: true, metadata: { 'doc-id': 'D1' } },
  });

  it('returns raw bodies unchanged', async () => {
    const res = await getObject(client, 'b', 'o/s/plain.html');
    assert.equal(res.body.toString(), '<main>plain</main>');
    assert.deepEqual(res.metadata, { id: 'u1' });
    assert.equal(res.contentEncoding, undefined);
  });
  it('decompresses gzip-encoded bodies (hlx6)', async () => {
    const res = await getObject(client, 'b', 'o/s/zipped.html');
    assert.equal(res.body.toString(), '<main>zipped</main>');
    assert.equal(res.contentEncoding, 'gzip');
  });
  it('returns metadata and headers without the body on head', async () => {
    const res = await headObject(client, 'b', 'o/s/zipped.html');
    assert.deepEqual(res.metadata, { 'doc-id': 'D1' });
    assert.equal(res.contentType, 'text/html');
    assert.equal(res.lastModified, '2026-01-01T00:00:00.000Z');
    assert.equal(res.body, undefined);
  });
});
