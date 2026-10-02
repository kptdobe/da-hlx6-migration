import { toHlx6Path } from './paths.js';
import { normalizeHtml, normalizeMetadata } from './normalize.js';

const CURRENT_KINDS = ['doc', 'sheet', 'media', 'folder'];

function countBy(entries, fn) {
  const out = {};
  entries.forEach((e) => {
    const k = fn(e);
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

function firstDiff(a, b, context = 60) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return null;
  const start = Math.max(0, i - 20);
  return {
    offset: i,
    da: a.slice(start, i + context),
    hlx6: b.slice(start, i + context),
  };
}

/**
 * Compares two bodies; HTML is also compared after whitespace normalization.
 */
export function compareBodies(kind, daBody, hlx6Body) {
  if (!daBody || !hlx6Body) return { compared: false };
  if (Buffer.compare(daBody, hlx6Body) === 0) return { compared: true, equal: true };
  const a = daBody.toString('utf8');
  const b = hlx6Body.toString('utf8');
  if (kind === 'doc') {
    const na = normalizeHtml(a);
    const nb = normalizeHtml(b);
    if (na === nb) return { compared: true, equal: false, equalNormalized: true };
    return {
      compared: true, equal: false, equalNormalized: false, diff: firstDiff(na, nb),
    };
  }
  if (kind === 'sheet') {
    try {
      const equalJson = JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
      if (equalJson) return { compared: true, equal: false, equalNormalized: true };
    } catch {
      // not JSON, fall through
    }
    return {
      compared: true, equal: false, equalNormalized: false, diff: firstDiff(a, b),
    };
  }
  return {
    compared: true, equal: false, sizeDa: daBody.length, sizeHlx6: hlx6Body.length,
  };
}

/**
 * Collects the set of metadata shapes (normalized) per object kind.
 * @returns {Record<string, {keys: string[], examples: object[]}>}
 */
export function metadataShapes(entries) {
  const out = {};
  entries.forEach((e) => {
    const shape = out[e.kind] ||= { keys: new Set(), examples: new Map(), contentEncodings: new Set() };
    Object.keys(e.metadata || {}).forEach((k) => shape.keys.add(k));
    shape.contentEncodings.add(e.contentEncoding || 'none');
    const norm = normalizeMetadata(e.metadata);
    shape.examples.set(JSON.stringify(norm), norm);
  });
  return Object.fromEntries(Object.entries(out).map(([kind, s]) => [kind, {
    keys: [...s.keys].sort(),
    contentEncodings: [...s.contentEncodings].sort(),
    examples: [...s.examples.values()],
  }]));
}

function docIdOf(backend, entry) {
  return backend === 'da' ? entry.metadata?.id : entry.metadata?.['doc-id'];
}

/**
 * Groups versions per logical document path.
 * The doc path is resolved from the current (or trashed) object carrying the doc id,
 * falling back to version metadata (`path` on da, `doc-path-hint` on hlx6).
 */
export function versionsByDoc(backend, entries) {
  const idToPath = new Map();
  entries.forEach((e) => {
    const id = docIdOf(backend, e);
    if (id && (CURRENT_KINDS.includes(e.kind) || e.kind === 'trash')) {
      idToPath.set(id, e.kind === 'trash' ? `/.trash${e.path}` : e.path);
    }
  });
  const out = {};
  entries.filter((e) => e.kind === 'version').forEach((e) => {
    let docPath = idToPath.get(e.docId);
    if (!docPath) {
      const hint = backend === 'da' ? e.metadata?.path : e.metadata?.['doc-path-hint'];
      docPath = hint ? `(orphan) ${backend === 'da' ? `/${hint.split('/').slice(1).join('/')}` : hint}` : `(orphan) ${e.docId}`;
    }
    const v = out[docPath] ||= { docId: e.docId, count: 0, labels: [] };
    v.count += 1;
    const label = backend === 'da' ? e.metadata?.label : e.metadata?.['version-comment'];
    const op = backend === 'hlx6' ? e.metadata?.['version-operation'] : undefined;
    if (label || op) v.labels.push([op, label].filter(Boolean).join(': '));
  });
  return out;
}

/**
 * Counts audit lines per da document id.
 */
export function auditByDoc(entries) {
  const out = {};
  entries.filter((e) => e.kind === 'audit' && e.body).forEach((e) => {
    const lines = e.body.toString('utf8').split('\n').filter((l) => l.trim());
    out[e.docId] = (out[e.docId] || 0) + lines.length;
  });
  return out;
}

/**
 * Structural comparison of a da dump and an hlx6 dump of the same content.
 * @param {object[]} da da entries (from scanSite / readDump)
 * @param {object[]} hlx6 hlx6 entries
 */
export function compareDumps(da, hlx6) {
  const hlx6Current = new Map(hlx6.filter((e) => CURRENT_KINDS.includes(e.kind))
    .map((e) => [`${e.kind}:${e.path}`, e]));

  const matched = [];
  const onlyDa = [];
  da.filter((e) => CURRENT_KINDS.includes(e.kind)).forEach((e) => {
    const hlx6Path = toHlx6Path(e.path);
    const key = `${e.kind}:${hlx6Path}`;
    const other = hlx6Current.get(key);
    if (!other) {
      onlyDa.push({ kind: e.kind, path: e.path, expectedHlx6Path: hlx6Path });
      return;
    }
    hlx6Current.delete(key);
    matched.push({
      kind: e.kind,
      daPath: e.path,
      hlx6Path: other.path,
      renamed: hlx6Path !== e.path,
      contentType: { da: e.contentType, hlx6: other.contentType },
      size: { da: e.size, hlx6: other.size, hlx6Uncompressed: Number(other.metadata?.['uncompressed-length']) || undefined },
      body: e.kind === 'folder' ? { compared: false } : compareBodies(e.kind, e.body, other.body),
    });
  });
  const onlyHlx6 = [...hlx6Current.values()].map((e) => ({ kind: e.kind, path: e.path }));

  return {
    counts: {
      da: countBy(da, (e) => e.kind),
      hlx6: countBy(hlx6, (e) => e.kind),
    },
    current: { matched, onlyDa, onlyHlx6 },
    metadata: { da: metadataShapes(da), hlx6: metadataShapes(hlx6) },
    versions: { da: versionsByDoc('da', da), hlx6: versionsByDoc('hlx6', hlx6) },
    audit: { da: auditByDoc(da) },
    trash: {
      da: da.filter((e) => e.kind === 'trash').map((e) => ({ path: e.path, docPath: e.metadata?.path })),
      hlx6: hlx6.filter((e) => e.kind === 'trash').map((e) => ({ path: e.path, docPath: e.metadata?.['doc-path'] })),
    },
  };
}
