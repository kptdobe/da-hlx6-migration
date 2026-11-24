import { preflight } from './preflight.js';
import { splitExt, toHlx6Path } from './paths.js';
import { deterministicUlid } from './ulid.js';
import { parse, serialize } from 'parse5';
import { rewriteDaBody } from './da-urls.js';

const CONTENT_TYPES = {
  '.avif': 'image/avif',
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

export function parseAudit(body, sourceKey = 'audit log', onInvalid = (failure) => {
  console.warn(`SKIPPED malformed-audit-record: ${failure.key}:${failure.line}: ${failure.error}`);
}) {
  return body.toString('utf8').split('\n').map((line, index) => {
    if (!line.trim()) return null;
    const invalid = (error) => {
      onInvalid({ key: sourceKey, line: index + 1, record: line, error, action: 'skipped-record' });
      return null;
    };
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length < 3) return invalid('expected timestamp, users and path');
    let label = '';
    let versionId = '';
    if (parts.length >= 5) {
      versionId = parts.pop();
      label = parts.pop();
    } else if (parts.length === 4) {
      versionId = parts.pop();
    }
    const [timestamp, rawUsers] = parts;
    const path = parts.slice(2).join('\t');
    const parsedTimestamp = timestamp.trim() ? Number(timestamp) : NaN;
    if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp < 0
      || parsedTimestamp > 281474976710655) return invalid('invalid timestamp');
    const normalizedPath = path.startsWith('/') ? path : sitePath(path);
    if (!path || !normalizedPath.startsWith('/') || normalizedPath.endsWith('/')
      || normalizedPath.split('/').some((part) => ['.', '..', '.versions', '.history'].includes(part))) {
      return invalid('invalid document path');
    }
    let users;
    try {
      users = JSON.parse(rawUsers);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('invalid users JSON');
    }
    if (!Array.isArray(users) || users.some((user) => typeof user?.email !== 'string' || !user.email)) {
      return invalid('expected an array of users with email addresses');
    }
    return {
      timestamp: parsedTimestamp,
      user: firstEmail(users),
      users: users.map(({ email }) => email.toLowerCase()),
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
  const bySource = new Map();
  const invalidRecords = [];
  entries.filter((entry) => entry.kind === 'audit').forEach((entry) => {
    if (!entry.body) throw new Error(`Missing DA audit body: ${entry.key}`);
    const events = parseAudit(entry.body, entry.key, (failure) => invalidRecords.push(failure));
    bySource.set(entry.key, events);
    const docEvents = byDoc.get(entry.docId) || [];
    events.forEach((event) => docEvents.push(event));
    byDoc.set(entry.docId, docEvents);
    events.filter((event) => event.versionId).forEach((event) => {
      byVersion.set(`${entry.docId}/${event.versionId}`, event);
    });
  });
  return { byDoc, byVersion, bySource, invalidRecords };
}

function buildDocId(entry, auditIndex) {
  const id = entry.metadata?.id || entry.key;
  const events = auditIndex.byDoc.get(id) || [];
  const fallback = Number(entry.metadata?.timestamp) || 0;
  const timestamp = events.reduce((earliest, event) => Math.min(earliest, event.timestamp),
    events.length ? Infinity : fallback);
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
  if (entry.kind === 'trash' && entry.trashedKind === 'folder') {
    return makeFolderPlan({ ...entry, path: entry.path.slice(0, -'.props'.length) }, scope, auditIndex);
  }
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
  const isTrash = entry.kind === 'trash';
  const markerPath = `${isTrash ? '/.trash' : ''}${toHlx6Path(entry.path)}`;
  const key = `${scope.org}/${scope.hlx6Site}${markerPath}/.props`;
  const folderEntry = { ...entry, metadata: entry.metadata || {} };
  const docId = buildDocId(folderEntry, auditIndex);
  const metadata = commonMetadata(folderEntry, docId, body,
    isTrash ? sitePath(entry.metadata?.path) : undefined);
  metadata['da-id'] ||= folderEntry.metadata.id || entry.key;
  return {
    kind: isTrash ? 'trash' : 'folder',
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
  const timestamp = audit?.timestamp ?? (Number(entry.metadata?.timestamp) || 0);
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

function makeAuditPlan(entry, scope, auditIndex, docIdByDaId, versions, missingSnapshots) {
  const docId = docIdByDaId.get(entry.docId);
  const activities = auditIndex.bySource.get(entry.key).map((event, index) => {
    const snapshot = event.versionId ? versions.get(`${entry.docId}/${event.versionId}`) : undefined;
    if (event.versionId && !snapshot) {
      missingSnapshots.push({ key: entry.key, versionId: event.versionId, action: 'omitted-snapshot' });
    }
    return {
      v: 1,
      id: deterministicUlid(event.timestamp, JSON.stringify(['da-audit', entry.key, index, event])),
      t: event.timestamp,
      op: event.versionId || event.label ? 'version' : 'edit',
      u: event.users,
      p: toHlx6Path(event.path.startsWith('/') ? event.path : sitePath(event.path)),
      ...(event.label && { label: event.label }),
      ...(snapshot && { snapshot }),
    };
  }).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const first = activities[0] || { t: 0, id: deterministicUlid(0, `da-audit-file:${entry.key}`) };
  const name = entry.key.endsWith('/audit.txt')
    ? 'audit.jsonl' : `${String(first.t).padStart(16, '0')}-${first.id}.jsonl`;
  const body = Buffer.from(activities.map((activity) => `${JSON.stringify(activity)}\n`).join(''), 'utf8');
  return {
    kind: 'audit',
    sourceKey: entry.key,
    key: `${scope.org}/${scope.hlx6Site}/.versions/${docId}/audit/${name}`,
    body,
    contentType: 'application/x-ndjson',
    contentEncoding: 'gzip',
    metadata: { 'doc-id': docId, 'da-id': entry.docId, 'uncompressed-length': String(body.length) },
    docId,
    daId: entry.docId,
  };
}

/**
 * Builds an immutable plan; performs no network or storage writes.
 * @param {object[]} entries DA dump entries from readDump().
 * @param {{org:string, daOrg?:string, daSite:string, hlx6Site:string}} scope Migration scope.
 * @returns {object} Original-body plan, URL rewrites, exclusions and warnings.
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
  const versions = new Map(objects.filter((object) => object.kind === 'version' && object.contentType)
    .map((object) => [`${object.daId}/${object.versionId}`, object.versionUlid]));
  const missingSnapshots = [];
  entries.filter((entry) => entry.kind === 'audit')
    .forEach((entry) => objects.push(makeAuditPlan(entry, scope, auditIndex, docIdByDaId, versions, missingSnapshots)));

  const unsupported = objects.filter((object) => object.contentType === undefined);
  const supported = objects.filter((object) => object.contentType !== undefined);
  const urlRewrites = [];
  const unsupportedUrls = [];
  for (const object of supported) {
    const result = rewriteDaBody(object, scope);
    urlRewrites.push(...result.rewrites.map((item) => ({ key: object.sourceKey, ...item })));
    unsupportedUrls.push(...result.unsupported.map((item) => ({ key: object.sourceKey, ...item })));
  }
  return {
    scope: { org: scope.org, daSite: scope.daSite, hlx6Site: scope.hlx6Site },
    objects: supported,
    urlRewrites,
    excluded: [
      ...entries.filter((entry) => entry.kind === 'props-sidecar')
        .map((entry) => ({ key: entry.key, kind: entry.kind })),
      ...unsupported.map((object) => ({
        key: object.sourceKey, kind: object.kind, reason: 'unsupported-extension',
      })),
    ],
    warnings: [
      ...checks.checks.filter((check) => check.severity === 'warning' && check.count),
      ...(unsupportedUrls.length ? [{
        id: 'unrewritten-da-urls', severity: 'warning',
        description: 'Same-site DA admin URLs without a URL-only API mapping were retained',
        count: unsupportedUrls.length, items: unsupportedUrls,
      }] : []),
      ...(auditIndex.invalidRecords.length ? [{
        id: 'malformed-audit-records', severity: 'warning',
        description: 'Malformed DA audit records were skipped; see items for original lines',
        count: auditIndex.invalidRecords.length, items: auditIndex.invalidRecords,
      }] : []),
      ...(missingSnapshots.length ? [{
        id: 'audit-snapshots-not-migrated', severity: 'warning',
        description: 'Audit events retained without snapshot links because their versions were not migrated',
        count: missingSnapshots.length, items: missingSnapshots,
      }] : []),
    ],
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
  return url.startsWith('./media_')
    || Boolean(org && site && (url.startsWith(`https://main--${site}--${org}.aem.page/`)
      || url.startsWith(`https://main--${site}--${org}.aem.live/`)))
    || /^https:\/\/[^/]+\/adobe\/dynamicmedia\/deliver\//.test(url);
}

function visitElements(node, callback) {
  if (node.tagName) callback(node);
  (node.childNodes || []).forEach((child) => visitElements(child, callback));
  if (node.content) visitElements(node.content, callback);
}

export function collectImageUrls(html) {
  const urls = new Set();
  visitElements(parse(html), (node) => {
    if (!['img', 'source'].includes(node.tagName)) return;
    (node.attrs || []).forEach(({ name, value }) => {
      if (name === 'src') urls.add(value);
      if (name === 'srcset') {
        parseSrcset(value).forEach(({ url }) => urls.add(url));
      }
    });
  });
  return [...urls];
}

export function collectExternalImageUrls(html, org, site) {
  return collectImageUrls(html).filter((url) => !shouldKeepImageUrl(url, org, site));
}

export function rewriteImageUrls(html, replacements, org, site) {
  if (!replacements.size) return html;
  const rewrittenUrl = (url) => (shouldKeepImageUrl(url, org, site) ? url : replacements.get(url) || url);
  const document = parse(html);
  visitElements(document, (node) => {
    if (!['img', 'source'].includes(node.tagName)) return;
    node.attrs = (node.attrs || []).map(({ name, value }) => {
      if (name === 'src') {
        return { name, value: rewrittenUrl(value) };
      }
      if (name === 'srcset') {
        const candidates = parseSrcset(value);
        if (candidates.every(({ url }) => rewrittenUrl(url) === url)) return { name, value };
        const rewritten = candidates.map(({ url, descriptor }) => (
          `${rewrittenUrl(url)}${descriptor ? ` ${descriptor}` : ''}`
        )).join(', ');
        return { name, value: rewritten };
      }
      return { name, value };
    });
  });
  return serialize(document);
}