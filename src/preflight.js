import { toHlx6Path } from './paths.js';
import { isSupportedOnHlx6 } from './classify.js';

const CURRENT_KINDS = ['doc', 'sheet', 'media', 'folder'];

/**
 * Pre-flight checks on a da site listing before migrating it to hlx6.
 * Each check: { id, severity: 'blocking'|'warning', count, items }.
 * @param {object[]} entries classified da entries (see classifyDa); need `metadata` for orphan detection
 */
export function preflight(entries) {
  const current = entries.filter((e) => CURRENT_KINDS.includes(e.kind));

  const unsupported = current
    .filter((e) => e.kind !== 'folder' && !isSupportedOnHlx6(e.path))
    .map((e) => e.path);

  const byHlx6Key = new Map();
  current.forEach((e) => {
    const hlx6Key = `${e.kind === 'folder' ? 'folder' : 'file'}:${toHlx6Path(e.path)}`;
    if (!byHlx6Key.has(hlx6Key)) byHlx6Key.set(hlx6Key, []);
    byHlx6Key.get(hlx6Key).push(e.path);
  });
  const collisions = [...byHlx6Key.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([hlx6Key, paths]) => ({ hlx6Path: hlx6Key.split(':')[1], paths }));

  const renamed = current
    .filter((e) => toHlx6Path(e.path) !== e.path)
    .map((e) => ({ from: e.path, to: toHlx6Path(e.path) }));

  const liveIds = new Set(entries
    .filter((e) => CURRENT_KINDS.includes(e.kind) || e.kind === 'trash')
    .map((e) => e.metadata?.id).filter(Boolean));
  const versionIds = new Set(entries.filter((e) => e.kind === 'version' || e.kind === 'audit').map((e) => e.docId));
  const orphans = [...versionIds].filter((id) => !liveIds.has(id));

  const others = entries
    .filter((e) => e.kind === 'props-sidecar')
    .map((e) => e.path);

  const checks = [
    {
      id: 'unsupported-extensions', severity: 'blocking', description: 'Files with extensions hlx6 does not accept', count: unsupported.length, items: unsupported,
    },
    {
      id: 'path-collisions', severity: 'blocking', description: 'Several da paths map to the same hlx6 path', count: collisions.length, items: collisions,
    },
    {
      id: 'renamed-paths', severity: 'warning', description: 'Paths renamed by hlx6 sanitization', count: renamed.length, items: renamed,
    },
    {
      id: 'orphan-versions', severity: 'warning', description: 'Version folders whose document no longer exists', count: orphans.length, items: orphans,
    },
    {
      id: 'unmapped-objects', severity: 'warning', description: 'File property sidecars with no hlx6 mapping', count: others.length, items: others,
    },
  ];
  return {
    ok: checks.every((c) => c.severity !== 'blocking' || c.count === 0),
    checks,
  };
}
