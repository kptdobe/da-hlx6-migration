import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSite, writeDump, readDump } from '../src/dump.js';
import { fakeClient } from './fixtures/fake-client.js';

const daObjects = {
  'kptdobe/sample-da/index.html': { body: '<body><main>home</main></body>', metadata: { id: 'id-1', path: 'sample-da/index.html' } },
  'kptdobe/sample-da/folder.props': { body: '{}', contentType: 'application/json' },
  'kptdobe/sample-da/.da-versions/id-1/v1.html': { body: '<body><main>old</main></body>', metadata: { label: 'v1' } },
  'kptdobe/sample-da/.da-versions/id-1/audit.txt': { body: '1\t[]\t/index.html\t\t\n', contentType: 'text/plain' },
  'kptdobe/sample-da-other/index.html': { body: 'not this site' },
};

describe('scanSite', () => {
  it('reports listing and download counts and bytes, including empty sites', async () => {
    const events = [];
    const entries = await scanSite({
      client: fakeClient(daObjects, 2), backend: 'da', bucket: 'aem-content',
      org: 'kptdobe', site: 'sample-da', onProgress: (event) => events.push(event),
    });
    assert.ok(events.some((event) => event.phase.startsWith('Listing shards') && event.total === 4));
    const downloads = events.filter((event) => event.phase.startsWith('Downloading'));
    assert.deepEqual(downloads.map((event) => event.completed), [0, 1, 2, 3, 4]);
    assert.equal(downloads.at(-1).total, 4);
    assert.equal(downloads.at(-1).bytes, entries.reduce((sum, entry) => sum + entry.body.length, 0));
    const empty = [];
    await scanSite({
      client: fakeClient({}), backend: 'da', bucket: 'aem-content',
      org: 'kptdobe', site: 'empty', onProgress: (event) => empty.push(event),
    });
    assert.equal(empty.at(-1).completed, 0);
    assert.equal(empty.at(-1).total, 0);
  });
  it('lists only the requested site and classifies each object', async () => {
    const entries = await scanSite({
      client: fakeClient(daObjects), backend: 'da', bucket: 'aem-content', org: 'kptdobe', site: 'sample-da',
    });
    assert.deepEqual(entries.map((e) => [e.rel, e.kind]), [
      ['/.da-versions/id-1/audit.txt', 'audit'],
      ['/.da-versions/id-1/v1.html', 'version'],
      ['/folder.props', 'folder'],
      ['/index.html', 'doc'],
    ]);
    const index = entries.find((e) => e.rel === '/index.html');
    assert.equal(index.body.toString(), '<body><main>home</main></body>');
    assert.deepEqual(index.metadata, { id: 'id-1', path: 'sample-da/index.html' });
  });

  it('only issues HEAD requests when bodies are not requested', async () => {
    const client = fakeClient(daObjects);
    const entries = await scanSite({
      client, backend: 'da', bucket: 'aem-content', org: 'kptdobe', site: 'sample-da', withBodies: false,
    });
    assert.equal(entries.length, 4);
    assert.ok(entries.every((e) => e.body === undefined));
    assert.ok(!client.calls.includes('GetObjectCommand'));
  });

  it('decompresses hlx6 gzip bodies and classifies hlx6 layout', async () => {
    const client = fakeClient({
      'kptdobe/s/folder/.props': { body: '{}', gzip: true, metadata: { 'doc-id': 'F1' } },
      'kptdobe/s/.versions/D1/V1': { body: '<main>v</main>', gzip: true, metadata: { 'doc-id': 'D1' } },
    });
    const entries = await scanSite({
      client, backend: 'hlx6', bucket: 'helix-source-bus', org: 'kptdobe', site: 's',
    });
    assert.deepEqual(entries.map((e) => [e.kind, e.body.toString()]), [['version', '<main>v</main>'], ['folder', '{}']]);
    assert.equal(entries[0].contentEncoding, 'gzip');
  });
});

describe('writeDump / readDump', () => {
  it('round-trips manifest and bodies through the file system', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dump-'));
    try {
      const entries = await scanSite({
        client: fakeClient(daObjects), backend: 'da', bucket: 'aem-content', org: 'kptdobe', site: 'sample-da',
      });
      const writes = [];
      await writeDump(dir, entries, { onProgress: (event) => writes.push(event) });
      assert.equal(writes.at(-1).completed, entries.length);
      const onDisk = await fs.readFile(path.join(dir, 'files', 'index.html'), 'utf8');
      assert.equal(onDisk, '<body><main>home</main></body>');

      const reads = [];
      const back = await readDump(dir, { onProgress: (event) => reads.push(event) });
      assert.equal(reads.at(-1).completed, entries.length);
      assert.equal(back.length, 4);
      const version = back.find((e) => e.kind === 'version');
      assert.equal(version.body.toString(), '<body><main>old</main></body>');
      assert.deepEqual(version.metadata, { label: 'v1' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
