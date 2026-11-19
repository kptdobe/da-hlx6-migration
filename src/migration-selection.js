import processQueue from '@adobe/helix-shared-process-queue';
import { classifyDa } from './classify.js';

export function normalizeIgnoredFolders(folders = []) {
  if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== 'string'
    || !folder.startsWith('/') || /[\r\n\0]/.test(folder)
    || folder.replace(/\/+$/, '').split('/').slice(1).some((part) => !part || part === '.' || part === '..'))) {
    throw new Error('Ignored folders must be absolute site paths without empty, "." or ".." segments');
  }
  const normalized = [...new Set(folders.map((folder) => folder.replace(/\/+$/, '')))];
  if (normalized.includes('')) throw new Error('Ignoring the site root is not allowed');
  return normalized.filter((folder) => !normalized.some((parent) => folder !== parent && folder.startsWith(`${parent}/`)));
}

/**
 * Selects before body reads. DA history uses identity keys, requiring metadata
 * for ignored non-media current files and remaining versions whose path hints may match.
 */
export async function selectMigrationEntries(entries, {
  source, ignoredFolders, readMetadata, concurrency = 24, onProgress = () => {},
  onExcluded = () => {},
}) {
  if (!ignoredFolders.length) return entries;
  const matches = (value) => typeof value === 'string'
    && ignoredFolders.some((folder) => value === folder || value.startsWith(`${folder}/`));
  const classified = entries.map((entry) => ({
    entry, ...classifyDa(entry.key.slice(source.length)),
  }));
  const excluded = new Set(entries.filter((entry) => matches(entry.key.slice(source.length))).map((entry) => entry.key));
  const ignoredIds = new Set();
  const missingIgnoredKeys = new Set();
  const metadata = async (entry) => entry.metadata ?? readMetadata(entry.key);
  let completed = 0;
  const phase = 'Resolving ignored folders and version identities';
  const hasHistory = classified.some(({ kind }) => kind === 'version' || kind === 'audit');
  const candidates = classified.filter((item) => !['version', 'audit'].includes(item.kind)
    && (excluded.has(item.entry.key) || matches(item.path)));
  onProgress({ phase, completed, total: candidates.length });
  await processQueue(candidates, async ({ entry, kind, trashedKind }) => {
    excluded.add(entry.key);
    if (hasHistory && (kind === 'trash' ? trashedKind : kind) !== 'media') {
      try {
        const meta = await metadata(entry);
        if (meta.id) ignoredIds.add(meta.id);
      } catch (error) {
        const status = error.$metadata?.httpStatusCode;
        const missing = status === 404 || (status === undefined
          && [error.name, error.code, error.Code].some((code) => ['NotFound', 'NoSuchKey'].includes(code)));
        if (!missing) throw error;
        missingIgnoredKeys.add(entry.key);
        onProgress({ phase: 'Skipping missing ignored source object', key: entry.key, status: 'ignored-not-found' });
      }
    }
    completed += 1;
    onProgress({ phase, completed, total: candidates.length, key: entry.key });
  }, concurrency);
  const versions = classified.filter(({ entry, kind, docId }) => kind === 'version'
    && !excluded.has(entry.key) && !ignoredIds.has(docId));
  completed = 0;
  onProgress({ phase, completed, total: versions.length });
  await processQueue(versions, async ({ entry, docId }) => {
    const meta = await metadata(entry);
    // DA metadata paths include the site name, but not the organization.
    const hintedPath = typeof meta.path === 'string' && meta.path.includes('/')
      ? meta.path.slice(meta.path.indexOf('/')) : undefined;
    if (matches(hintedPath)) excluded.add(entry.key);
    if (missingIgnoredKeys.has(`${source}${hintedPath}`)) ignoredIds.add(docId);
    completed += 1;
    onProgress({ phase, completed, total: versions.length, key: entry.key });
  }, concurrency);
  return classified.filter(({ entry, kind, docId }) => {
    if (!excluded.has(entry.key) && !(['version', 'audit'].includes(kind) && ignoredIds.has(docId))) return true;
    onExcluded({
      key: entry.key, kind, reason: 'ignored-folder',
      ...(missingIgnoredKeys.has(entry.key) && { metadataStatus: 'not-found' }),
    });
    return false;
  }).map(({ entry }) => entry);
}
