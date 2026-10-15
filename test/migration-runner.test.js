import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { inspectDestination, runMigration } from '../src/migration-runner.js';

const scope = { org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6-migrated' };
const object = {
  kind: 'doc',
  key: 'kptdobe/sample-content-hlx6-migrated/index.html',
  body: Buffer.from('<main>hello</main>'),
  contentType: 'text/html',
  contentEncoding: 'gzip',
  metadata: { 'da-id': 'doc-id', 'doc-id': 'doc-ulid' },
};
const sourceHash = createHash('sha256').update(object.body).digest('hex');

function fakeClient(keys = [], heads = {}) {
  const writes = [];
  return {
    writes,
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return {
          Contents: keys.map((key) => ({ Key: key, LastModified: new Date(), Size: 1 })),
          IsTruncated: false,
        };
      }
      if (name === 'HeadObjectCommand') {
        if (!heads[command.input.Key]) {
          const error = new Error('NotFound');
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return { Metadata: heads[command.input.Key] };
      }
      if (name === 'PutObjectCommand') {
        writes.push(command.input);
        return {};
      }
      throw new Error(`Unexpected ${name}`);
    },
  };
}

describe('inspectDestination', () => {
  it('accepts an empty destination', async () => {
    const client = fakeClient();
    const result = await inspectDestination(client, scope, [object]);
    assert.equal(result.get(object.key), 'planned');
  });
  it('refuses any key not included in the migration plan', async () => {
    const client = fakeClient(['kptdobe/sample-content-hlx6-migrated/manual.html']);
    await assert.rejects(inspectDestination(client, scope, [object]), /unplanned objects/);
  });
  it('only skips an existing object whose DA id and original body hash match', async () => {
    const client = fakeClient([object.key], {
      [object.key]: { 'da-id': 'doc-id', 'da-source-sha256': sourceHash },
    });
    const result = await inspectDestination(client, scope, [object]);
    assert.equal(result.get(object.key), 'exists');
  });
  it('requires overwrite even for an identical prior migration object during execution', async () => {
    const client = fakeClient([object.key], {
      [object.key]: { 'da-id': 'doc-id', 'da-source-sha256': sourceHash },
    });
    await assert.rejects(runMigration({ objects: [object] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
    }), /execution requires --overwrite/);
    assert.equal(client.writes.length, 0);
  });
  it('refuses an existing object not owned by this migration', async () => {
    const client = fakeClient([object.key], { [object.key]: { 'da-id': 'other' } });
    await assert.rejects(inspectDestination(client, scope, [object]), /not an identical migration object/);
  });
});

describe('runMigration', () => {
  it('overwrites existing planned content only when explicitly requested', async () => {
    const client = fakeClient([object.key], { [object.key]: { 'da-id': 'other' } });
    const result = await runMigration({ objects: [object] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
      overwrite: true,
    });
    assert.equal(result.statuses.get(object.key), 'overwrite');
    assert.equal(client.writes.length, 1);
    assert.equal(client.writes[0].Key, object.key);
    assert.equal(client.writes[0].IfNoneMatch, undefined);
    assert.equal(result.results[0].status, 'written');
  });

  it('plans overwrites without writing in a dry run', async () => {
    const client = fakeClient([object.key]);
    const result = await runMigration({ objects: [object] }, { client, scope, overwrite: true });
    assert.equal(result.statuses.get(object.key), 'overwrite');
    assert.equal(client.writes.length, 0);
  });

  it('dry-run reports API upload candidates and excludes target-site URLs', async () => {
    const client = fakeClient();
    const sourceUrls = [
      'https://content.da.live/adobecom/da-events/image.jpg',
      'https://main--da-events--adobecom.aem.page/media_a.jpg',
      'https://main--da-events--adobecom.aem.live/media_b.jpg',
    ];
    const html = `<main><img src="${sourceUrls[0]}"><source srcset="${sourceUrls[1]} 1x, ${sourceUrls[2]} 2x, https://external.example/image.jpg 3x"><img src="https://main--sample-content-hlx6-migrated--kptdobe.aem.page/media_target.jpg"></main>`;
    const result = await runMigration({ objects: [{ ...object, body: Buffer.from(html) }] }, {
      client, scope: { ...scope, daOrg: 'adobecom', daSite: 'da-events' },
      fetchImpl: () => { throw new Error('Dry run must not fetch images'); },
    });
    assert.deepEqual(result.imageUrls, [...sourceUrls, 'https://external.example/image.jpg']);
    assert.equal(client.writes.length, 0);
  });

  it('still refuses unplanned target content when overwriting', async () => {
    const client = fakeClient(['kptdobe/sample-content-hlx6-migrated/manual.html']);
    await assert.rejects(runMigration({ objects: [object] }, {
      client, scope, execute: true, overwrite: true,
    }), /unplanned objects/);
    assert.equal(client.writes.length, 0);
  });

  it('dry-runs without any PutObject calls', async () => {
    const client = fakeClient();
    const events = [];
    const result = await runMigration({ objects: [object] }, {
      client, scope, onProgress: (event) => events.push(event),
    });
    assert.ok(events.some((event) => event.phase === 'Checking destination conflicts'
      && event.completed === 1 && event.total === 1));
    assert.match(events.at(-1).phase, /dry run; no uploads/);
    assert.equal(result.dryRun, true);
    assert.equal(client.writes.length, 0);
    assert.equal(result.objects, 1);
  });

  it('writes only planned target keys and gzip-encodes text bodies', async () => {
    const client = fakeClient();
    const events = [];
    const result = await runMigration({ objects: [object] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
      onProgress: (event) => events.push(event),
    });
    assert.ok(events.some((event) => event.phase === 'Uploading images' && event.total === 0));
    assert.equal(events.at(-1).completed, 1);
    assert.equal(events.at(-1).total, 1);
    assert.equal(events.at(-1).status, 'written');
    assert.equal(result.results.length, 1);
    assert.equal(client.writes.length, 1);
    assert.equal(client.writes[0].Key, object.key);
    assert.equal(client.writes[0].ContentEncoding, 'gzip');
    assert.equal(client.writes[0].Metadata['da-source-sha256'], sourceHash);
  });

  it('refuses source-site image documents without a media token before source writes', async () => {
    const client = fakeClient();
    const imageDoc = {
      ...object,
      body: Buffer.from('<main><img src="https://content.da.live/kptdobe/sample-content-da/a.jpg"></main>'),
    };
    await assert.rejects(runMigration({ objects: [imageDoc] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
    }), /API token/);
    assert.equal(client.writes.length, 0);
  });

  it('keeps failed image references and records every failure without blocking content writes', async () => {
    const client = fakeClient();
    const html = '<main><img src="https://events-data-dev.aws125.adobeitc.com/image.png"><source srcset="https://images.example/a.jpg 1x, https://images.example/b.jpg 2x"></main>';
    const result = await runMigration({ objects: [{ ...object, body: Buffer.from(html) }] }, {
      client, scope: { ...scope, daOrg: 'adobecom', write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
      execute: true,
      mediaToken: 'test-token',
      fetchImpl: () => { throw new Error('Image fetch failed (403)'); },
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.imageUrls.length, 3);
    assert.equal(result.imageErrors.length, 3);
    assert.ok(result.imageErrors.every(({ error, sourceKeys }) => error === 'Image fetch failed (403)' && sourceKeys.includes(object.key)));
    assert.equal(gunzipSync(client.writes[0].Body).toString(), html);
  });

  it('uploads non-kept images and only rewrites successes when another image fails', async () => {
    const client = fakeClient();
    const sourceUrl = 'https://content.da.live/adobecom/sample-content-da/images/a.jpg';
    const external = 'https://events-data-dev.aws125.adobeitc.com/image.png';
    const html = `<main><img src="${sourceUrl}"><img src="${external}"></main>`;
    const calls = [];
    const result = await runMigration({ objects: [{ ...object, body: Buffer.from(html) }] }, {
      client, scope: { ...scope, daOrg: 'adobecom', write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
      execute: true, mediaToken: 'media-token', daSourceToken: 'source-token',
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method || 'GET' });
        if (url === sourceUrl) {
          assert.equal(options.headers.authorization, 'Bearer source-token');
          return {
            ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        }
        if (url === external) {
          assert.equal(options.headers.authorization, undefined);
          return { ok: false, status: 403 };
        }
        assert.equal(url, 'https://api.aem.live/kptdobe/sites/sample-content-hlx6-migrated/media/');
        return { ok: true, json: async () => ({ uri: 'https://main--sample-content-hlx6-migrated--kptdobe.aem.page/media_abc.jpg' }) };
      },
    });
    assert.deepEqual(result.imageUrls, [sourceUrl, external]);
    assert.equal(calls.filter(({ method }) => method === 'GET').length, 2);
    assert.equal(calls.filter(({ method }) => method === 'POST').length, 1);
    assert.equal(result.imageErrors.length, 1);
    assert.equal(result.imageErrors[0].url, external);
    assert.match(result.imageErrors[0].error, /Image fetch failed \(403\)/);
    const written = gunzipSync(client.writes[0].Body).toString();
    assert.ok(written.includes('src="./media_abc.jpg"'));
    assert.ok(written.includes(`src="${external}"`));
  });

  it('finishes writing versions before starting current documents', async () => {
    const version = {
      kind: 'version',
      key: 'kptdobe/sample-content-hlx6-migrated/.versions/doc/v1',
      body: Buffer.from('<main>old</main>'),
      contentType: 'text/html',
      contentEncoding: 'gzip',
      metadata: { 'da-version-id': 'v1', 'doc-id': 'doc-ulid' },
    };
    const document = { ...object, key: 'kptdobe/sample-content-hlx6-migrated/index.html' };
    const client = fakeClient();
    const result = await runMigration({ objects: [document, version] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
    });
    assert.equal(client.writes.length, 2);
    assert.equal(client.writes[0].Key, version.key);
    assert.equal(client.writes[1].Key, document.key);
    assert.equal(result.results[0].kind, 'version');
  });
});