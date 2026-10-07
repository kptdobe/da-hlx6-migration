import { splitExt } from './paths.js';

// Extensions accepted by the hlx6 source API (helix-api-service src/source/utils.js).
export const HLX6_EXTENSIONS = ['.gif', '.html', '.ico', '.jpeg', '.jpg', '.json', '.mp4', '.pdf', '.png', '.svg'];

function byExtension(path) {
  const { ext } = splitExt(path.split('/').pop());
  const lower = ext.toLowerCase();
  if (lower === '.html') return 'doc';
  if (lower === '.json') return 'sheet';
  return 'media';
}

/**
 * Classifies a da (R2) object key relative to `{org}/{site}`.
 * @param {string} rel key relative to the site, e.g. `/folder/nested.html`
 * @returns {{kind: string, path?: string, docId?: string, versionId?: string}}
 */
export function classifyDa(rel) {
  let m = rel.match(/^\/\.da-versions\/([^/]+)\/(audit[^/]*\.txt)$/);
  if (m) return { kind: 'audit', docId: m[1] };
  m = rel.match(/^\/\.da-versions\/([^/]+)\/([^/]+)$/);
  if (m) return { kind: 'version', docId: m[1], versionId: splitExt(m[2]).base };
  m = rel.match(/^\/\.da\/comments\/([^/]+)\//);
  if (m) return { kind: 'comment', docId: m[1] };
  if (rel === '/.da/config.json') return { kind: 'sheet', path: rel };
  if (rel.startsWith('/.da/')) return { kind: 'da-internal', path: rel };
  if (rel.startsWith('/.trash/')) {
    // da-live moves deleted items to /.trash/{name}-{iso-date}.{ext} (client-side, da-list.js)
    const inner = rel.slice('/.trash'.length);
    return { kind: 'trash', path: inner, trashedKind: classifyDa(inner).kind };
  }

  const name = rel.split('/').pop();
  const parts = name.split('.');
  if (parts.at(-1) === 'props') {
    // `folder.props` marks a folder; `file.jpg.props` is a sidecar
    return parts.length === 2
      ? { kind: 'folder', path: rel.slice(0, -'.props'.length) }
      : { kind: 'props-sidecar', path: rel };
  }
  return { kind: byExtension(rel), path: rel };
}

/**
 * Classifies an hlx6 (S3 source bus) object key relative to `{org}/{site}`.
 * @param {string} rel key relative to the site, e.g. `/folder/.props`
 */
export function classifyHlx6(rel) {
  let m = rel.match(/^\/\.versions\/([^/]+)\/([^/]+)$/);
  if (m) return { kind: 'version', docId: m[1], versionId: m[2] };
  if (rel.startsWith('/.trash/')) {
    const inner = rel.slice('/.trash'.length);
    return { kind: 'trash', path: inner, trashedKind: classifyHlx6(inner).kind };
  }
  if (rel.endsWith('/.props')) return { kind: 'folder', path: rel.slice(0, -'/.props'.length) };
  return { kind: byExtension(rel), path: rel };
}

export function isSupportedOnHlx6(path) {
  return HLX6_EXTENSIONS.includes(splitExt(path.split('/').pop()).ext.toLowerCase());
}
