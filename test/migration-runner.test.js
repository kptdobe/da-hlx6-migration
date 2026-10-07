import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  it('uses the source hash marker to resume an identical prior migration object', async () => {
    const client = fakeClient([object.key], {
      [object.key]: { 'da-id': 'doc-id', 'da-source-sha256': sourceHash },
    });
    const result = await runMigration({ objects: [object] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
    });
    assert.equal(result.statuses.get(object.key), 'exists');
    assert.equal(result.results.length, 0);
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

  it('still refuses unplanned target content when overwriting', async () => {
    const client = fakeClient(['kptdobe/sample-content-hlx6-migrated/manual.html']);
    await assert.rejects(runMigration({ objects: [object] }, {
      client, scope, execute: true, overwrite: true,
    }), /unplanned objects/);
    assert.equal(client.writes.length, 0);
  });

  it('dry-runs without any PutObject calls', async () => {
    const client = fakeClient();
    const result = await runMigration({ objects: [object] }, { client, scope });
    assert.equal(result.dryRun, true);
    assert.equal(client.writes.length, 0);
    assert.equal(result.objects, 1);
  });

  it('writes only planned target keys and gzip-encodes text bodies', async () => {
    const client = fakeClient();
    const result = await runMigration({ objects: [object] }, {
      client,
      scope: {
        ...scope,
        write: [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }],
      },
      execute: true,
    });
    assert.equal(result.results.length, 1);
    assert.equal(client.writes.length, 1);
    assert.equal(client.writes[0].Key, object.key);
    assert.equal(client.writes[0].ContentEncoding, 'gzip');
    assert.equal(client.writes[0].Metadata['da-source-sha256'], sourceHash);
  });

  it('refuses external-image documents without a media token before source writes', async () => {
    const client = fakeClient();
    const imageDoc = {
      ...object,
      body: Buffer.from('<main><img src="https://images.example/a.jpg"></main>'),
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