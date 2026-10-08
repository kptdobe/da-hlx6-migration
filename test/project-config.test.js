import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateProjectConfig } from '../src/project-config.js';

const scope = { org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6' };
it('reads cross-org source config without writing either site during a dry-run', async () => {
  const calls = [];
  const events = [];
  const result = await migrateProjectConfig({
    scope: { org: 'kptdobe', daOrg: 'adobecom', daSite: 'da-events', hlx6Site: 'da-events-migrated' },
    configToken: 'test-token',
    onProgress: (event) => events.push(event),
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(result.status, 'planned');
  assert.match(events[0].phase, /Reading DA project config.*adobecom\/da-events/);
  assert.match(events[1].phase, /Reading target project config.*kptdobe\/sites\/da-events-migrated/);
  assert.deepEqual(calls, [
    { url: 'https://admin.da.live/config/adobecom/da-events', method: 'GET' },
    { url: 'https://api.aem.live/kptdobe/sites/da-events-migrated/config.json', method: 'GET' },
  ]);
});
const daUrl = 'https://admin.da.live/config/kptdobe/sample-content-da';
const targetUrl = 'https://api.aem.live/kptdobe/sites/sample-content-hlx6/config.json';
const sheetConfig = {
  data: [
    { title: 'home', path: '[/](https://api.aem.live/)' },
    { title: 'en', path: '[/en](https://api.aem.live/en)' },
  ],
  alex: [{ key: 'config1', value: 'very important' }],
};
const wrappedSheets = {
  data: {
    total: 2, limit: 2, offset: 0, data: sheetConfig.data, ':colWidths': [50, 50],
  },
  alex: {
    total: 1, limit: 1, offset: 0, data: sheetConfig.alex, ':colWidths': [50, 50],
  },
};
const daConfig = {
  ':version': 3,
  ':properties': { author: 'sample-author' },
  ...wrappedSheets,
};
const targetConfig = { content: { source: { url: 'https://example.com/source' } }, editor: { other: true } };

function api(source = daConfig, target = targetConfig) {
  const calls = [];
  return {
    calls,
    target,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url === daUrl) {
        return source === null
          ? new Response(null, { status: 404 })
          : Response.json(source);
      }
      if (options.method) {
        assert.equal(url, targetUrl.replace('/config.json', '/config/editor/da.json'));
        target.editor = { ...target.editor, da: JSON.parse(options.body) };
        return Response.json({});
      }
      assert.equal(url, targetUrl);
      return Response.json(target);
    },
  };
}

describe('migrateProjectConfig', () => {
  it('copies site config to editor.da without changing other target properties', async () => {
    const fake = api(daConfig, structuredClone(targetConfig));
    const result = await migrateProjectConfig({
      scope, execute: true, daConfigToken: 'da-token', configToken: 'aem-token', ...fake,
    });
    assert.equal(result.status, 'written');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer da-token');
    assert.equal(fake.calls.length, 3);
    const write = fake.calls[2];
    assert.equal(write.method, 'POST');
    assert.equal(write.headers.authorization, 'Bearer aem-token');
    assert.equal(write.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(write.body), sheetConfig);
    assert.deepEqual(fake.target, {
      ...targetConfig, editor: { other: true, da: sheetConfig },
    });
  });

  it('plans config migration without writing in a dry run', async () => {
    const fake = api();
    const result = await migrateProjectConfig({ scope, configToken: 'aem-token', ...fake });
    assert.equal(result.status, 'planned');
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls.every((call) => !call.method));
  });

  it('skips a site without DA config', async () => {
    const fake = api(null);
    const result = await migrateProjectConfig({ scope, execute: true, ...fake });
    assert.equal(result.status, 'absent');
    assert.equal(fake.calls.length, 1);
  });

  it('skips an identical editor.da on repeat runs', async () => {
    const fake = api(daConfig, { ...targetConfig, editor: { da: sheetConfig } });
    const result = await migrateProjectConfig({ scope, execute: true, configToken: 'aem-token', ...fake });
    assert.equal(result.status, 'exists');
    assert.equal(fake.calls.length, 2);
  });

  it('removes metadata from a previously migrated config without changing its sheets', async () => {
    const fake = api(daConfig, { ...targetConfig, editor: { other: true, da: daConfig } });
    const result = await migrateProjectConfig({ scope, execute: true, configToken: 'aem-token', ...fake });
    assert.equal(result.status, 'written');
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(JSON.parse(fake.calls[2].body), sheetConfig);
    assert.deepEqual(fake.target.editor, { other: true, da: sheetConfig });
  });

  it('only plans cleanup of legacy metadata during a dry run', async () => {
    const fake = api(daConfig, { editor: { da: daConfig } });
    const result = await migrateProjectConfig({ scope, configToken: 'aem-token', ...fake });
    assert.equal(result.status, 'planned');
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.target.editor.da, daConfig);
  });

  it('flattens previously migrated sheet wrappers even when top-level metadata is absent', async () => {
    const fake = api(daConfig, { editor: { da: wrappedSheets } });
    const result = await migrateProjectConfig({ scope, execute: true, configToken: 'aem-token', ...fake });
    assert.equal(result.status, 'written');
    assert.deepEqual(fake.target.editor.da, sheetConfig);
  });

  it('preserves empty sheets and row properties while removing sheet-level metadata', async () => {
    const source = {
      ':properties': {},
      empty: { total: 0, data: [], ':colWidths': [] },
      config: { data: [{ key: 'label', ':value': 'retained' }], ':colWidths': [50, 50] },
    };
    const fake = api(source, {});
    await migrateProjectConfig({ scope, execute: true, configToken: 'aem-token', ...fake });
    assert.deepEqual(JSON.parse(fake.calls[2].body), {
      empty: [], config: [{ key: 'label', ':value': 'retained' }],
    });
  });

  it('rejects sheets without a data array before reading or writing the target', async () => {
    const fake = api({ alex: { total: 1 } });
    await assert.rejects(migrateProjectConfig({
      scope, execute: true, configToken: 'aem-token', ...fake,
    }), /data array/);
    assert.equal(fake.calls.length, 1);
  });

  it('refuses to replace an existing different editor.da', async () => {
    const fake = api(daConfig, { editor: { da: { data: [] } } });
    await assert.rejects(migrateProjectConfig({ scope, configToken: 'aem-token', ...fake }), /editor.da/);
    assert.equal(fake.calls.length, 2);
  });

  it('requires a target config token when DA config exists', async () => {
    const fake = api();
    await assert.rejects(migrateProjectConfig({ scope, execute: true, ...fake }), /API token/);
    assert.equal(fake.calls.length, 1);
  });

  it('fails on DA authorization errors rather than treating config as absent', async () => {
    await assert.rejects(migrateProjectConfig({
      scope, fetchImpl: async () => new Response(null, { status: 403 }),
    }), /DA config fetch failed \(403\)/);
  });
});