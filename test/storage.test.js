import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDevVars, listAll, getObject, headObject, createClient, putObject,
} from '../src/storage.js';
import { createScope } from '../src/scope.js';
import { fakeClient } from './fixtures/fake-client.js';

describe('parseDevVars', () => {
  it('reads KEY=VALUE lines, skipping comments and blanks', () => {
    const vars = parseDevVars('# R2 token\nS3_ACCESS_KEY_ID=abc\n\nS3_DEF_URL=https://x.r2.cloudflarestorage.com\n');
    assert.deepEqual(vars, { S3_ACCESS_KEY_ID: 'abc', S3_DEF_URL: 'https://x.r2.cloudflarestorage.com' });
  });
  it('keeps "=" inside values and strips surrounding quotes', () => {
    assert.deepEqual(parseDevVars('SECRET="a=b=c"'), { SECRET: 'a=b=c' });
  });
});

describe('createClient', () => {
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
    org: 'kptdobe', daSite: 'sample-content-da', site: 'sample-content-hlx6-migrated', daContentBusId: 'a'.repeat(59), contentBusId: 'b'.repeat(59),
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
