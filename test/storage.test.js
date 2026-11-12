import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  it('rereads locally refreshed AWS credentials for a new preparation in the same process', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-aws-refresh-'));
    const credentialsFile = path.join(directory, 'credentials');
    const configFile = path.join(directory, 'config');
    const keys = ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const clients = [];
    try {
      process.env.AWS_PROFILE = 'refresh-test';
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
      process.env.AWS_CONFIG_FILE = configFile;
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[key];
      await fs.writeFile(configFile, '', { mode: 0o600 });
      for (const version of ['before', 'after']) {
        await fs.writeFile(credentialsFile, `[refresh-test]
aws_access_key_id=${version}-key
aws_secret_access_key=${version}-secret
aws_session_token=${version}-token
`, { mode: 0o600 });
        const client = createClient('hlx6');
        clients.push(client);
        const credentials = await client.config.credentials();
        assert.equal(credentials.accessKeyId, `${version}-key`);
        assert.equal(credentials.secretAccessKey, `${version}-secret`);
        assert.equal(credentials.sessionToken, `${version}-token`);
      }
    } finally {
      clients.forEach((client) => client.destroy());
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
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

describe('storage error context', () => {
  const bucket = 'aem-content';
  const key = 'org/site/drafts/esp-stage/page.html';
  const scope = {
    write: [{ bucket: 'helix-source-bus', prefix: 'org/site/' }],
  };
  for (const [operation, run] of [
    ['HeadObject', (client) => headObject(client, bucket, key)],
    ['GetObject', (client) => getObject(client, bucket, key)],
    ['ListObjectsV2', (client) => listAll(client, bucket, 'org/site/')],
    ['ListObjectsV2', (client) => listSharded(client, bucket, 'org/site/', { concurrency: 1 })],
    ['PutObject', (client) => putObject(client, scope, { Bucket: 'helix-source-bus', Key: 'org/site/page.html', Body: 'x' })],
  ]) {
    it(`preserves HTTP diagnostics and identity for failed ${operation} requests`, async () => {
      const original = Object.assign(new Error('UnknownError'), {
        name: 'UnknownError',
        $metadata: { httpStatusCode: 503, attempts: 5, requestId: 'request-123', extendedRequestId: 'extended-123' },
        $response: { headers: { 'cf-ray': 'ray-123', authorization: 'private-header' }, body: 'private-response' },
        'Token-0': 'private-token',
      });
      await assert.rejects(run({ async send() { throw original; } }), (error) => {
        assert.equal(error.name, original.name);
        assert.equal(error.cause, original);
        assert.deepEqual(error.$metadata, original.$metadata);
        assert.equal(error.storageError.operation, operation);
        assert.equal(error.storageError.serviceCode, 'UnknownError');
        assert.equal(error.storageError.httpStatusCode, 503);
        assert.equal(error.storageError.attempts, 5);
        assert.equal(error.storageError.requestId, 'request-123');
        assert.equal(error.storageError.extendedRequestId, 'extended-123');
        assert.equal(error.storageError.cfRay, 'ray-123');
        assert.match(error.message, new RegExp(`${operation} failed for "s3://`));
        assert.match(error.message, /HTTP 503 Service Unavailable/);
        assert.match(error.message, /attempts=5/);
        assert.match(error.message, /requestId="request-123"/);
        assert.match(error.message, /Storage throttling or service failure/);
        if (operation === 'ListObjectsV2') {
          assert.equal(error.storageError.prefix, 'org/site/');
          assert.equal(error.storageError.key, undefined);
        } else {
          assert.equal(error.storageError.key, operation === 'PutObject' ? 'org/site/page.html' : key);
        }
        assert.doesNotMatch(error.message + JSON.stringify(error.storageError), /private-header|private-response|private-token/);
        return true;
      });
    });
  }

  it('distinguishes missing objects and access failures without changing service codes', async () => {
    for (const [name, status, hint] of [
      ['NoSuchKey', 404, /Object not found.*deleted after listing/],
      ['UnknownError', 404, /Object not found.*deleted after listing/],
      ['AccessDenied', 403, /Check storage credentials and bucket\/object permissions/],
    ]) {
      const original = Object.assign(new Error(name), { name, code: name, $metadata: { httpStatusCode: status } });
      await assert.rejects(headObject({ async send() { throw original; } }, bucket, key), (error) => {
        assert.equal(error.name, name);
        assert.equal(error.code, name);
        assert.equal(error.$metadata.httpStatusCode, status);
        assert.match(error.message, hint);
        return true;
      });
    }
  });

  it('uses the service Code and raw response status when SDK metadata is absent', async () => {
    const original = Object.assign(new Error('UnknownError'), {
      name: 'UnknownError', Code: 'SlowDown',
      $response: { statusCode: 429, headers: { 'x-amz-request-id': 'header-request' } },
    });
    await assert.rejects(headObject({ async send() { throw original; } }, bucket, key), (error) => {
      assert.equal(error.Code, 'SlowDown');
      assert.equal(error.$metadata.httpStatusCode, 429);
      assert.equal(error.storageError.serviceCode, 'SlowDown');
      assert.equal(error.storageError.requestId, 'header-request');
      assert.match(error.message, /SlowDown; HTTP 429 Too Many Requests/);
      return true;
    });
  });

  it('keeps transport failures explicit when no HTTP response exists', async () => {
    const original = new Error('Connection failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    await assert.rejects(headObject({ async send() { throw original; } }, bucket, key), (error) => {
      assert.match(error.message, /HTTP status unavailable/);
      assert.match(error.message, /causeCode="ECONNRESET"/);
      assert.match(error.message, /Connection failed/);
      assert.equal(error.storageError.httpStatusCode, undefined);
      return true;
    });
  });

  it('includes the object context when the response body or gzip decoding fails', async () => {
    for (const gzip of [false, true]) {
      const client = {
        async send() {
          return {
            $metadata: { httpStatusCode: 200, requestId: 'body-request' },
            ContentEncoding: gzip ? 'gzip' : undefined,
            Body: { async transformToByteArray() {
              if (!gzip) throw Object.assign(new Error('Stream interrupted'), { code: 'ECONNRESET' });
              return Buffer.from('not gzip');
            } },
          };
        },
      };
      await assert.rejects(getObject(client, bucket, key), (error) => {
        assert.equal(error.storageError.operation, 'GetObject');
        assert.equal(error.storageError.key, key);
        assert.equal(error.storageError.httpStatusCode, 200);
        assert.equal(error.storageError.requestId, 'body-request');
        assert.match(error.message, gzip ? /Z_DATA_ERROR/ : /Stream interrupted/);
        return true;
      });
    }
  });
});
