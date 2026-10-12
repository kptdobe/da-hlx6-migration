import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createScope, sessionTags, sessionName, assertWritable,
} from '../src/scope.js';

const DA_MEDIA = 'cdb7c31a0884cd980ae35142093dbd9e12dd50a3ad8f106e472d50255a8';
const HLX6_MEDIA = '8a228067304382d0717c282ae08947b512ada27852b0c144dc9ba0afce4';
const spec = {
  org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6-migrated', daContentBusId: DA_MEDIA, hlx6ContentBusId: HLX6_MEDIA,
};

describe('createScope', () => {
  it('separates the source organization from the target-only write prefix', () => {
    const scope = createScope({ ...spec, daOrg: 'adobecom' });
    assert.equal(scope.daOrg, 'adobecom');
    assert.equal(scope.org, 'kptdobe');
    assert.deepEqual(scope.write, [{ bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' }]);
    assert.equal(sessionTags(scope).find(({ Key }) => Key === 'da-org').Value, 'adobecom');
    assert.throws(() => createScope({ ...spec, daOrg: '*' }), /Invalid daOrg/);
  });
  it('allows writes only to the hlx6 site in the source bus', () => {
    assert.deepEqual(createScope(spec).write, [
      { bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' },
    ]);
  });
  it('rejects names that could widen an IAM policy variable', () => {
    ['*', 'kptdobe/*', '', 'Kptdobe', 'a?b', '../x'].forEach((org) => {
      assert.throws(() => createScope({ ...spec, org }), /Invalid org/);
    });
    assert.throws(() => createScope({ ...spec, hlx6Site: 'x*' }), /Invalid hlx6Site/);
    assert.throws(() => createScope({ ...spec, hlx6ContentBusId: '*' }), /Invalid hlx6ContentBusId/);
  });
  it('allows the da and hlx6 contentBusIds to be identical for stable-ID migration', () => {
    const stableScope = createScope({ ...spec, hlx6ContentBusId: DA_MEDIA });
    assert.deepEqual(stableScope.write, [
      { bucket: 'helix-source-bus', prefix: 'kptdobe/sample-content-hlx6-migrated/' },
    ]);
  });
});

describe('sessionTags', () => {
  it('carries every scope value expected by the role policy', () => {
    assert.deepEqual(sessionTags(createScope(spec)), [
      { Key: 'org', Value: 'kptdobe' },
      { Key: 'da-site', Value: 'sample-content-da' },
      { Key: 'hlx6-site', Value: 'sample-content-hlx6-migrated' },
      { Key: 'da-content-bus-id', Value: DA_MEDIA },
      { Key: 'hlx6-content-bus-id', Value: HLX6_MEDIA },
      { Key: 'da-org', Value: 'kptdobe' },
    ]);
  });
  it('names the session after the hlx6 site, within the STS 64 char limit', () => {
    assert.equal(sessionName(createScope(spec)), 'mig-kptdobe-sample-content-hlx6-migrated');
    assert.ok(sessionName(createScope({ ...spec, hlx6Site: 'x'.repeat(63) })).length <= 64);
  });
});

describe('assertWritable', () => {
  const scope = createScope(spec);
  it('accepts keys inside the hlx6 site', () => {
    assert.doesNotThrow(() => assertWritable(scope, 'helix-source-bus', 'kptdobe/sample-content-hlx6-migrated/index.html'));
  });
  it('refuses every media-bus write: images go through the media API', () => {
    assert.throws(() => assertWritable(scope, 'helix-media-bus', `${HLX6_MEDIA}/14bee32b72`), /Write refused/);
  });
  it('refuses the reference sites, other sites, other buckets and the da media', () => {
    [
      ['helix-source-bus', 'kptdobe/sample-content-hlx6/index.html'],
      ['helix-source-bus', 'kptdobe/sample-content-hlx6-migrated-other/index.html'],
      ['helix-source-bus', 'adobe/site/index.html'],
      ['aem-content', 'kptdobe/sample-content-hlx6-migrated/index.html'],
      ['helix-media-bus', `${DA_MEDIA}/14bee32b72`],
      ['helix-config-bus', 'orgs/kptdobe/sites/sample-content-hlx6-migrated.json'],
    ].forEach(([bucket, key]) => assert.throws(() => assertWritable(scope, bucket, key), /Write refused/));
  });
  it('refuses path traversal out of the hlx6 site', () => {
    assert.throws(() => assertWritable(scope, 'helix-source-bus', 'kptdobe/sample-content-hlx6-migrated/../sample-content-hlx6/x.html'), /Write refused/);
  });
});

describe('generic migration IAM templates', () => {
  it('requires all scope tags from the trusted principal without approving particular sites', () => {
    const policy = JSON.parse(readFileSync(new URL('../infra/aws/trust-policy.json', import.meta.url), 'utf8'));
    const rule = policy.Statement[0];
    assert.match(rule.Principal.AWS, /^arn:aws:iam::\d{12}:role\//);
    assert.equal(rule.Condition.StringEquals, undefined);
    assert.deepEqual(rule.Condition['ForAllValues:StringEquals']['aws:TagKeys'],
      sessionTags(createScope(spec)).map(({ Key }) => Key));
    for (const { Key } of sessionTags(createScope(spec))) {
      assert.equal(rule.Condition.Null[`aws:RequestTag/${Key}`], 'false');
    }
  });

  it('reads source config in the source org and confines writes to the target site', () => {
    const policy = JSON.parse(readFileSync(new URL('../infra/aws/migration-role-policy.json', import.meta.url), 'utf8'));
    const bySid = Object.fromEntries(policy.Statement.map((statement) => [statement.Sid, statement]));
    assert.deepEqual(bySid.ReadSiteConfigs.Resource, [
      'arn:aws:s3:::helix-config-bus/orgs/${aws:PrincipalTag/da-org}/sites/${aws:PrincipalTag/da-site}.json',
      'arn:aws:s3:::helix-config-bus/orgs/${aws:PrincipalTag/org}/sites/${aws:PrincipalTag/hlx6-site}.json',
    ]);
    assert.equal(bySid.ReadWriteTargetSite.Resource,
      'arn:aws:s3:::helix-source-bus/${aws:PrincipalTag/org}/${aws:PrincipalTag/hlx6-site}/*');
    assert.equal(bySid.DenyWithoutSourceOrg.Effect, 'Deny');
    assert.ok(bySid.NeverDeleteOrReconfigure.Action.includes('s3:DeleteObject'));
  });
});
