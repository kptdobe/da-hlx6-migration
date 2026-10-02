const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CONTENT_BUS_ID = /^[0-9a-f]{32,64}$/;

export const SOURCE_BUS = 'helix-source-bus';
export const MEDIA_BUS = 'helix-media-bus';

// Session tag keys; must match the policy variables in infra/aws/migration-role-policy.json.
export const TAG_KEYS = ['org', 'da-site', 'hlx6-site', 'da-content-bus-id', 'hlx6-content-bus-id'];

/**
 * Describes what one migration run may touch.
 * @param {object} spec
 * @param {string} spec.org
 * @param {string} spec.daSite da source site (read only, on R2)
 * @param {string} spec.hlx6Site hlx6 site (written)
 * @param {string} spec.daContentBusId media-bus folder of the da site (read only)
 * @param {string} spec.hlx6ContentBusId media-bus folder of the hlx6 site
 */
export function createScope({
  org, daSite, hlx6Site, daContentBusId, hlx6ContentBusId,
}) {
  [['org', org], ['daSite', daSite], ['hlx6Site', hlx6Site]].forEach(([k, v]) => {
    if (!NAME.test(v || '')) throw new Error(`Invalid ${k}: ${v}`);
  });
  [['daContentBusId', daContentBusId], ['hlx6ContentBusId', hlx6ContentBusId]].forEach(([k, v]) => {
    if (!CONTENT_BUS_ID.test(v || '')) throw new Error(`Invalid ${k}: ${v}`);
  });
  if (daContentBusId === hlx6ContentBusId) throw new Error('da and hlx6 media folders must differ');
  return Object.freeze({
    org,
    daSite,
    hlx6Site,
    daContentBusId,
    hlx6ContentBusId,
    write: Object.freeze([
      { bucket: SOURCE_BUS, prefix: `${org}/${hlx6Site}/` },
      { bucket: MEDIA_BUS, prefix: `${hlx6ContentBusId}/` },
    ]),
  });
}

/**
 * STS session tags; the migration role grants nothing without them.
 * @returns {{Key: string, Value: string}[]}
 */
export function sessionTags(scope) {
  const values = [scope.org, scope.daSite, scope.hlx6Site, scope.daContentBusId, scope.hlx6ContentBusId];
  return TAG_KEYS.map((Key, i) => ({ Key, Value: values[i] }));
}

export function sessionName(scope) {
  return `mig-${scope.org}-${scope.hlx6Site}`.slice(0, 64);
}

export function assertWritable(scope, bucket, key) {
  const ok = typeof key === 'string'
    && !key.split('/').includes('..')
    && scope.write.some((w) => w.bucket === bucket && key.startsWith(w.prefix));
  if (!ok) throw new Error(`Write refused, outside migration scope: s3://${bucket}/${key}`);
}
