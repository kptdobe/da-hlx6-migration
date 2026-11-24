import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { inspectDestination, runMigration } from '../src/migration-runner.js';
import { buildMigrationPlan } from '../src/migration.js';
import { classifyDa } from '../src/classify.js';

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
  it('rewrites current/trash/version text at transfer time, preserving plans, bytes and source hashes', async () => {
    const sourceUrl = 'https://content.da.live/adobecom/sample-content-da/library/blocks/columns';
    const targetUrl = 'https://api.aem.live/kptdobe/sites/sample-content-hlx6-migrated/source/library/blocks/columns.html';
    const rows = [
      ['/index.html', `<a href="${sourceUrl}">Columns</a>`],
      ['/library/blocks.json', JSON.stringify({ data: [{ path: sourceUrl }] })],
      ['/.trash/blocks.json', JSON.stringify({ path: sourceUrl })],
      ['/.da-versions/doc-id/v1.html', `<a href="${sourceUrl}">Old columns</a>`],
      ['/icons/a.svg', `<svg><a href="${sourceUrl}"/></svg>`],
      ['/binary.pdf', Buffer.concat([Buffer.from([0, 255]), Buffer.from(sourceUrl)])],
    ].map(([rel, body]) => ({
      key: `adobecom/sample-content-da${rel}`, rel, ...classifyDa(rel), body: Buffer.from(body), metadata: {},
    }));
    const writeScope = { ...scope, daOrg: 'adobecom', write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] };
    const plan = buildMigrationPlan(rows, writeScope);
    assert.equal(plan.urlRewrites.length, 5);
    const client = fakeClient();
    const dryRun = await runMigration(plan, {
      client, scope: writeScope, fetchImpl: () => { throw new Error('Dry run must not fetch or write'); },
    });
    assert.deepEqual(dryRun.urlRewrites, plan.urlRewrites);
    assert.equal(client.writes.length, 0);
    const result = await runMigration(plan, { client, scope: writeScope, execute: true });
    assert.equal(result.urlRewrites.length, 5);
    for (const written of client.writes) {
      const original = plan.objects.find(({ key }) => key === written.Key);
      const source = rows.find(({ key }) => key === original.sourceKey);
      assert.equal(original.body, source.body);
      const body = written.ContentEncoding === 'gzip' ? gunzipSync(written.Body) : written.Body;
      assert.equal(written.Metadata['uncompressed-length'], String(body.length));
      assert.equal(written.Metadata['da-source-sha256'], createHash('sha256').update(source.body).digest('hex'));
      if (written.ContentType === 'application/pdf') assert.deepEqual(body, source.body);
      else {
        assert.ok(body.toString().includes(targetUrl));
        assert.ok(!body.toString().includes(sourceUrl));
      }
    }
    const heads = Object.fromEntries(client.writes.map(({ Key, Metadata }) => [Key, Metadata]));
    const statuses = await inspectDestination(fakeClient(client.writes.map(({ Key }) => Key), heads), writeScope, plan.objects);
    assert.ok([...statuses.values()].every((status) => status === 'exists'));
  });

  it('recognizes original-body ownership during a conditional-write race after URL rewriting', async () => {
    const body = Buffer.from('<a href="https://content.da.live/kptdobe/sample-content-da/page">Page</a>');
    const doc = { ...object, body };
    const client = fakeClient([], { [doc.key]: {
      'da-id': 'doc-id', 'da-source-sha256': createHash('sha256').update(body).digest('hex'),
    } });
    const send = client.send;
    client.send = async (command) => {
      if (command.constructor.name === 'PutObjectCommand') {
        throw Object.assign(new Error('Precondition failed'), { $metadata: { httpStatusCode: 412 } });
      }
      return send(command);
    };
    const result = await runMigration({ objects: [doc] }, {
      client, scope: { ...scope, write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
      execute: true,
    });
    assert.deepEqual(result.results, [{ key: doc.key, status: 'exists', kind: 'doc' }]);
  });

  it('uses the migrated source URL when a same-site DA image upload fails', async () => {
    const url = 'https://content.da.live/kptdobe/sample-content-da/image.jpg';
    const targetUrl = 'https://api.aem.live/kptdobe/sites/sample-content-hlx6-migrated/source/image.jpg';
    const body = Buffer.from(`<img src="${url}">`);
    const client = fakeClient();
    const result = await runMigration({ objects: [{ ...object, body }] }, {
      client, scope: { ...scope, write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
      execute: true, mediaToken: 'test-token',
      fetchImpl: async (requested) => {
        assert.equal(requested, url);
        return new Response(null, { status: 403 });
      },
    });
    assert.equal(result.imageErrors[0].action, 'rewritten-to-source-api');
    assert.equal(result.imageErrors[0].targetUrl, targetUrl);
    assert.equal(gunzipSync(client.writes[0].Body).toString(), `<img src="${targetUrl}">`);
    assert.deepEqual(result.urlRewrites, [{ key: object.key, url, targetUrl }]);
    assert.equal(client.writes[0].Metadata['da-source-sha256'], createHash('sha256').update(body).digest('hex'));
  });

  it('writes converted active/archive logs after snapshots and supports ownership checks on reruns', async () => {
    const rows = [
      ['/index.html', '<main>current</main>', { id: 'doc-id' }],
      ['/.da-versions/doc-id/v1.html', '<main>saved</main>', {}],
      ['/.da-versions/doc-id/audit-1000.txt', '1000\t[]\t/index.html\n', {}],
      ['/.da-versions/doc-id/audit.txt', 'invalid row\n2000\t[]\t/index.html\tPublished\tv1\n', {}],
    ].map(([rel, body, metadata]) => ({
      key: `kptdobe/sample-content-da${rel}`, rel, ...classifyDa(rel), body: Buffer.from(body), metadata,
    }));
    const plan = buildMigrationPlan(rows, scope);
    const client = fakeClient();
    const options = {
      client,
      scope: { ...scope, write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
    };
    const dryRun = await runMigration(plan, options);
    assert.equal(dryRun.objects, 4);
    assert.equal(client.writes.length, 0);
    const result = await runMigration(plan, { ...options, execute: true });
    assert.equal(result.results.length, 4);
    assert.deepEqual(client.writes.map(({ Key }) => plan.objects.find(({ key }) => key === Key).kind),
      ['version', 'audit', 'audit', 'doc']);
    const histories = client.writes.filter(({ ContentType }) => ContentType === 'application/x-ndjson');
    assert.equal(histories.length, 2);
    for (const history of histories) {
      assert.equal(history.ContentEncoding, 'gzip');
      assert.equal(history.IfNoneMatch, '*');
      const body = gunzipSync(history.Body);
      assert.equal(body.length, Number(history.Metadata['uncompressed-length']));
      assert.equal(history.Metadata['da-id'], 'doc-id');
      assert.equal(history.Metadata['da-source-sha256'], createHash('sha256').update(body).digest('hex'));
    }
    const activity = JSON.parse(gunzipSync(histories.find(({ Key }) => Key.endsWith('/audit.jsonl')).Body));
    assert.equal(activity.snapshot, client.writes[0].Key.split('/').at(-1));
    const keys = client.writes.map(({ Key }) => Key);
    const heads = Object.fromEntries(client.writes.map(({ Key, Metadata }) => [Key, Metadata]));
    const statuses = await inspectDestination(fakeClient(keys, heads), scope, plan.objects);
    assert.ok([...statuses.values()].every((status) => status === 'exists'));
    const changed = plan.objects.map((object) => (object.kind === 'audit'
      ? { ...object, body: Buffer.from('changed') } : object));
    await assert.rejects(inspectDestination(fakeClient(keys, heads), scope, changed), /not an identical migration object/);
  });

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

  it('still handles conditional-write races after storage errors gain diagnostic context', async () => {
    const client = fakeClient([], {
      [object.key]: { 'da-id': 'doc-id', 'da-source-sha256': sourceHash },
    });
    const send = client.send;
    client.send = async (command) => {
      if (command.constructor.name === 'PutObjectCommand') {
        throw Object.assign(new Error('Precondition failed'), {
          name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 },
        });
      }
      return send(command);
    };
    const result = await runMigration({ objects: [object] }, {
      client,
      scope: { ...scope, write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }] },
      execute: true,
    });
    assert.deepEqual(result.results, [{ key: object.key, status: 'exists', kind: 'doc' }]);
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
    assert.deepEqual(result.imageErrors, []);
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
    assert.deepEqual(result.imageErrors, []);
    assert.deepEqual(result.uploadedImageUrls, []);
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
    assert.deepEqual(result.urlRewrites, []);
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