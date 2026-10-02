import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScope, sessionTags, sessionName, assertWritable,
} from '../src/scope.js';

const DA_MEDIA = 'cdb7c31a0884cd980ae35142093dbd9e12dd50a3ad8f106e472d50255a8';
const TARGET_MEDIA = '8a228067304382d0717c282ae08947b512ada27852b0c144dc9ba0afce4';
const spec = {
  org: 'kptdobe', daSite: 'sample-content-da', site: 'sample-content-hlx6-migrated', daContentBusId: DA_MEDIA, contentBusId: TARGET_MEDIA,
};

describe('createScope', () => {
  it('allows writes only to the target site and its media folder', () => {
    assert.deepEqual(createScope(spec).write, [
      { bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' },
      { bucket: 'helix-media-bus', prefix: `${TARGET_MEDIA}/` },
    ]);
  });
  it('rejects names that could widen an IAM policy variable', () => {
    ['*', 'kptdobe/*', '', 'Kptdobe', 'a?b', '../x'].forEach((org) => {
      assert.throws(() => createScope({ ...spec, org }), /Invalid org/);
    });
    assert.throws(() => createScope({ ...spec, site: 'x*' }), /Invalid site/);
    assert.throws(() => createScope({ ...spec, contentBusId: '*' }), /Invalid contentBusId/);
  });
  it('rejects writing into the source media folder', () => {
    assert.throws(() => createScope({ ...spec, contentBusId: DA_MEDIA }), /must differ/);
  });
});

describe('sessionTags', () => {
  it('carries every scope value expected by the role policy', () => {
    assert.deepEqual(sessionTags(createScope(spec)), [
      { Key: 'org', Value: 'kptdobe' },
      { Key: 'da-site', Value: 'sample-content-da' },
      { Key: 'site', Value: 'sample-content-hlx6-migrated' },
      { Key: 'da-content-bus-id', Value: DA_MEDIA },
      { Key: 'content-bus-id', Value: TARGET_MEDIA },
    ]);
  });
  it('names the session after the target, within the STS 64 char limit', () => {
    assert.equal(sessionName(createScope(spec)), 'mig-kptdobe-sample-content-hlx6-migrated');
    assert.ok(sessionName(createScope({ ...spec, site: 'x'.repeat(63) })).length <= 64);
  });
});

describe('assertWritable', () => {
  const scope = createScope(spec);
  it('accepts keys inside the target site and target media folder', () => {
    assert.doesNotThrow(() => assertWritable(scope, 'helix-source-bus', 'kptdobe/sample-content-hlx6-migrated/index.html'));
    assert.doesNotThrow(() => assertWritable(scope, 'helix-media-bus', `${TARGET_MEDIA}/14bee32b72`));
  });
  it('refuses the reference sites, other sites, other buckets and the source media', () => {
    [
      ['helix-source-bus', 'kptdobe/sample-content-hlx6/index.html'],
      ['helix-source-bus', 'kptdobe/sample-content-hlx6-migrated-other/index.html'],
      ['helix-source-bus', 'adobe/site/index.html'],
      ['aem-content', 'kptdobe/sample-content-hlx6-migrated/index.html'],
      ['helix-media-bus', `${DA_MEDIA}/14bee32b72`],
      ['helix-config-bus', 'orgs/kptdobe/sites/sample-content-hlx6-migrated.json'],
    ].forEach(([bucket, key]) => assert.throws(() => assertWritable(scope, bucket, key), /Write refused/));
  });
  it('refuses path traversal out of the target', () => {
    assert.throws(() => assertWritable(scope, 'helix-source-bus', 'kptdobe/sample-content-hlx6-migrated/../sample-content-hlx6/x.html'), /Write refused/);
  });
});
