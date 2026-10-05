import { preflight } from './preflight.js';
import { splitExt, toHlx6Path } from './paths.js';
import { deterministicUlid } from './ulid.js';
import { parse, serialize } from 'parse5';

const CONTENT_TYPES = {
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const CURRENT_KINDS = new Set(['doc', 'sheet', 'media', 'trash']);

export function firstEmail(value) {
  try {
    const users = typeof value === 'string' ? JSON.parse(value) : value;
    return users?.[0]?.email || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function isoTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function parseAudit(body) {
  return body.toString('utf8').split('\n').filter(Boolean).map((line) => {
    const [timestamp, users, path, label = '', versionId = ''] = line.split('\t');
    const parsedTimestamp = Number(timestamp);
    if (!Number.isFinite(parsedTimestamp)) return null;
    return {
      timestamp: parsedTimestamp,
      user: firstEmail(users),
      path,
      label,
      versionId,
    };
  }).filter(Boolean);
}

function sitePath(value, fallback = '/') {
  if (!value) return fallback;
  const parts = String(value).split('/');
  if (parts.length > 1) parts.shift();
  return `/${parts.join('/')}`;
}

function getAuditIndex(entries) {
  const byDoc = new Map();
  const byVersion = new Map();
  entries.filter((entry) => entry.kind === 'audit' && entry.body).forEach((entry) => {
    const events = parseAudit(entry.body);
    byDoc.set(entry.docId, [...(byDoc.get(entry.docId) || []), ...events]);
    events.filter((event) => event.versionId).forEach((event) => {
      byVersion.set(`${entry.docId}/${event.versionId}`, event);
    });
  });
  return { byDoc, byVersion };
}

function buildDocId(entry, auditIndex) {
  const id = entry.metadata?.id || entry.key;
  const events = auditIndex.byDoc.get(id) || [];
  const fallback = Number(entry.metadata?.timestamp) || 0;
  const timestamp = events.length
    ? Math.min(...events.map((event) => event.timestamp))
    : fallback;
  return deterministicUlid(timestamp, `da-id:${id}`);
}

function commonMetadata(entry, docId, body, originalPath) {
  const metadata = {
    'doc-id': docId,
    'last-modified-by': firstEmail(entry.metadata?.users),
    'uncompressed-length': String(body.length),
    'doc-last-modified': isoTimestamp(entry.metadata?.timestamp),
    'da-id': entry.metadata?.id,
    'doc-path': originalPath,
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function makeCurrentPlan(entry, scope, auditIndex) {
  const body = entry.body || Buffer.alloc(0);
  const daId = entry.metadata?.id || entry.key;
  const docId = buildDocId(entry, auditIndex);
  const isTrash = entry.kind === 'trash';
  const relativePath = isTrash
    ? `/.trash${toHlx6Path(entry.path)}`
    : toHlx6Path(entry.path);
  const originalPath = isTrash ? sitePath(entry.metadata?.path) : undefined;
  const key = `${scope.org}/${scope.hlx6Site}${relativePath}`;
  const ext = splitExt(entry.key.split('/').at(-1)).ext.toLowerCase();
  const metadata = commonMetadata(entry, docId, body, originalPath);
  metadata['da-id'] ||= daId;
  const gzip = (isTrash ? entry.trashedKind : entry.kind) !== 'media';
  return {
    kind: isTrash ? 'trash' : entry.kind,
    sourceKey: entry.key,
    key,
    body,
    contentType: CONTENT_TYPES[ext],
    contentEncoding: gzip ? 'gzip' : undefined,
    metadata,
    docId,
    daId,
  };
}

function makeFolderPlan(entry, scope, auditIndex) {
  const body = Buffer.from('{}');
  const markerPath = toHlx6Path(entry.path);
  const key = `${scope.org}/${scope.hlx6Site}${markerPath}/.props`;
  const folderEntry = { ...entry, metadata: entry.metadata || {} };
  const docId = buildDocId(folderEntry, auditIndex);
  const metadata = commonMetadata(folderEntry, docId, body);
  metadata['da-id'] ||= folderEntry.metadata.id || entry.key;
  return {
    kind: 'folder',
    sourceKey: entry.key,
    key,
    body,
    contentType: 'application/json',
    contentEncoding: 'gzip',
    metadata,
    docId,
    daId: folderEntry.metadata.id || entry.key,
  };
}

function makeVersionPlan(entry, scope, auditIndex, docIdByDaId) {
  const body = entry.body || Buffer.alloc(0);
  const versionId = entry.versionId;
  const daId = entry.docId;
  const docId = docIdByDaId.get(daId) || deterministicUlid(0, `da-id:${daId}`);
  const audit = auditIndex.byVersion.get(`${daId}/${versionId}`);
  const timestamp = audit?.timestamp || Number(entry.metadata?.timestamp) || 0;
  const versionUlid = deterministicUlid(timestamp, `da-version-id:${versionId}`);
  const hintedPath = sitePath(entry.metadata?.path);
  const ext = splitExt(entry.key.split('/').at(-1)).ext.toLowerCase();
  const metadata = {
    'doc-id': docId,
    'doc-path-hint': toHlx6Path(hintedPath),
    'doc-last-modified': isoTimestamp(entry.metadata?.timestamp),
    'doc-last-modified-by': firstEmail(entry.metadata?.users),
    'version-by': audit?.user || firstEmail(entry.metadata?.users),
    'version-comment': entry.metadata?.label,
    'version-date': isoTimestamp(timestamp),
    'uncompressed-length': String(body.length),
    'da-version-id': versionId,
  };
  const gzip = ext === '.html' || ext === '.json';
  return {
    kind: 'version',
    sourceKey: entry.key,
    key: `${scope.org}/${scope.hlx6Site}/.versions/${docId}/${versionUlid}`,
    body,
    contentType: CONTENT_TYPES[ext],
    contentEncoding: gzip ? 'gzip' : undefined,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)),
    docId,
    daId,
    versionId,
    versionUlid,
  };
}

/**
 * Builds an immutable plan; performs no network or storage writes.
 * @param {object[]} entries DA dump entries from readDump().
 * @param {{org:string, daSite:string, hlx6Site:string}} scope
 */
export function buildMigrationPlan(entries, scope) {
  const checks = preflight(entries);
  if (!checks.ok) {
    const failed = checks.checks.filter((check) => check.severity === 'blocking' && check.count);
    throw new Error(`Migration preflight failed: ${failed.map((check) => `${check.id} (${check.count})`).join(', ')}`);
  }

  const auditIndex = getAuditIndex(entries);
  const current = entries.filter((entry) => CURRENT_KINDS.has(entry.kind));
  const docIdByDaId = new Map();
  const identityEntries = new Map();
  entries.forEach((entry) => {
    const daId = entry.metadata?.id || entry.docId || entry.key;
    const timestamp = Number(entry.metadata?.timestamp) || 0;
    const existingTimestamp = Number(identityEntries.get(daId)?.metadata?.timestamp) || 0;
    if (!identityEntries.has(daId) || (timestamp && (!existingTimestamp || timestamp < existingTimestamp))) {
      identityEntries.set(daId, { ...entry, metadata: { ...entry.metadata, id: daId } });
    }
  });
  identityEntries.forEach((entry, daId) => {
    docIdByDaId.set(daId, buildDocId(entry, auditIndex));
  });
  const objects = [];
  current.forEach((entry) => objects.push(makeCurrentPlan(entry, scope, auditIndex)));
  entries.filter((entry) => entry.kind === 'folder')
    .forEach((entry) => objects.push(makeFolderPlan(entry, scope, auditIndex)));
  entries.filter((entry) => entry.kind === 'version')
    .forEach((entry) => objects.push(makeVersionPlan(entry, scope, auditIndex, docIdByDaId)));

  const unsupported = objects.filter((object) => object.contentType === undefined);
  if (unsupported.length) {
    throw new Error(`Unsupported content types: ${unsupported.map((object) => object.sourceKey).join(', ')}`);
  }
  return {
    scope: { org: scope.org, daSite: scope.daSite, hlx6Site: scope.hlx6Site },
    objects,
    excluded: entries.filter((entry) => ['audit', 'comment', 'da-internal', 'props-sidecar'].includes(entry.kind))
      .map((entry) => ({ key: entry.key, kind: entry.kind })),
    warnings: checks.checks.filter((check) => check.severity === 'warning' && check.count),
  };
}

function parseSrcset(value) {
  const candidates = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position])) position += 1;
    if (position >= value.length) break;
    let url = '';
    while (position < value.length && !/\s/.test(value[position])) url += value[position++];
    const trailingCommas = url.match(/,+$/)?.[0].length || 0;
    if (trailingCommas) url = url.slice(0, -trailingCommas);
    let descriptor = '';
    if (!trailingCommas) {
      while (position < value.length && value[position] !== ',') descriptor += value[position++];
    }
    if (url) candidates.push({ url, descriptor: descriptor.trim() });
    while (position < value.length && value[position] === ',') position += 1;
  }
  return candidates;
}

function shouldKeepImageUrl(url, org, site) {
  if (!/^https?:\/\//i.test(url)) return true;
  return url.startsWith(`https://main--${site}--${org}.aem.page/`)
    || url.startsWith(`https://main--${site}--${org}.aem.live/`)
    || /^https:\/\/[^/]+\/adobe\/dynamicmedia\/deliver\//.test(url);
}

function visitElements(node, callback) {
  if (node.tagName) callback(node);
  (node.childNodes || []).forEach((child) => visitElements(child, callback));
  if (node.content) visitElements(node.content, callback);
}

export function collectExternalImageUrls(html, org, site) {
  const urls = new Set();
  visitElements(parse(html), (node) => {
    if (!['img', 'source'].includes(node.tagName)) return;
    (node.attrs || []).forEach(({ name, value }) => {
      if (name === 'src' && !shouldKeepImageUrl(value, org, site)) urls.add(value);
      if (name === 'srcset') {
        parseSrcset(value).filter(({ url }) => !shouldKeepImageUrl(url, org, site))
          .forEach(({ url }) => urls.add(url));
      }
    });
  });
  return [...urls];
}

export function rewriteImageUrls(html, replacements) {
  const document = parse(html);
  visitElements(document, (node) => {
    if (!['img', 'source'].includes(node.tagName)) return;
    node.attrs = (node.attrs || []).map(({ name, value }) => {
      if (name === 'src' && replacements.has(value)) {
        return { name, value: replacements.get(value) };
      }
      if (name === 'srcset') {
        const rewritten = parseSrcset(value).map(({ url, descriptor }) => (
          `${replacements.get(url) || url}${descriptor ? ` ${descriptor}` : ''}`
        )).join(', ');
        return { name, value: rewritten };
      }
      return { name, value };
    });
  });
  return serialize(document);
}