import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import processQueue from '@adobe/helix-shared-process-queue';
import { listSharded, getObject, headObject } from './storage.js';
import { classifyDa, classifyHlx6 } from './classify.js';

const CLASSIFIERS = { da: classifyDa, hlx6: classifyHlx6 };

function directoryPaths(paths) {
  const directories = new Set();
  for (const rel of paths) {
    const segments = rel.split('/');
    for (let index = 2; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return directories;
}

async function saveBody(outDir, entry, directories) {
  const relative = entry.rel.slice(1);
  const fallback = path.join('objects', createHash('sha256').update(entry.key).digest('hex'));
  const unsafe = relative.split('/').some((segment) => !segment || segment === '.' || segment === '..');
  let bodyFile = unsafe || directories.has(entry.rel) ? fallback : path.join('files', relative);
  try {
    await fs.mkdir(path.dirname(path.join(outDir, bodyFile)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(outDir, bodyFile), entry.body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!['EEXIST', 'EISDIR', 'ENOTDIR'].includes(error.code) || bodyFile === fallback) throw error;
    bodyFile = fallback;
    await fs.mkdir(path.dirname(path.join(outDir, bodyFile)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(outDir, bodyFile), entry.body, { flag: 'wx', mode: 0o600 });
  }
  return bodyFile;
}

/**
 * Lists a site and fetches every object's headers (and optionally body).
 * @param {object} opts
 * @param {import('@aws-sdk/client-s3').S3Client} opts.client
 * @param {'da'|'hlx6'} opts.backend
 * @param {string} opts.bucket
 * @param {string} opts.org
 * @param {string} opts.site
 * @param {boolean} [opts.withBodies=true]
 * @param {number} [opts.concurrency=20]
 * @returns {Promise<object[]>} manifest entries; with bodies, each entry has a `body` Buffer
 */
export async function scanSite({
  client, backend, bucket, org, site, withBodies = true, concurrency = 20,
  onProgress = () => {}, listingConcurrency = 8, outDir,
}) {
  const prefix = `${org}/${site}/`;
  const classify = CLASSIFIERS[backend];
  const listed = await listSharded(client, bucket, prefix, { onProgress, concurrency: listingConcurrency });
  if (outDir) await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const directories = outDir ? directoryPaths(listed.map((object) => `/${object.key.slice(prefix.length)}`)) : undefined;
  const manifest = [];
  let complete = false;
  const total = listed.length;
  let completed = 0;
  let bytes = 0;
  const phase = `${withBodies ? 'Downloading' : 'Reading headers'} ${backend} ${org}/${site}`;
  onProgress({ phase, completed, total, bytes });
  try {
    const entries = await processQueue(listed, async (obj) => {
      const rel = `/${obj.key.slice(prefix.length)}`;
      const res = withBodies
        ? await getObject(client, bucket, obj.key)
        : await headObject(client, bucket, obj.key);
      const entry = {
        key: obj.key,
        rel,
        ...classify(rel),
        size: obj.size,
        etag: res.etag,
        lastModified: res.lastModified,
        contentType: res.contentType,
        contentEncoding: res.contentEncoding,
        metadata: res.metadata,
        ...(withBodies && { body: res.body }),
      };
      if (outDir) {
        if (entry.body) entry.bodyFile = await saveBody(outDir, entry, directories);
        const record = { ...entry };
        delete record.body;
        manifest.push(record);
      }
      completed += 1;
      bytes += withBodies ? res.body.length : 0;
      onProgress({ phase, completed, total, bytes, key: obj.key });
      return entry;
    }, concurrency);
    complete = true;
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  } finally {
    if (outDir) {
      await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest.sort((a, b) => a.key.localeCompare(b.key)), null, 2), { mode: 0o600 });
      await fs.writeFile(path.join(outDir, 'snapshot.json'), JSON.stringify({ complete, downloaded: manifest.length, total }, null, 2), { mode: 0o600 });
    }
  }
}

/**
 * Writes scan results to `outDir/manifest.json` and bodies under `outDir/files/`.
 */
export async function writeDump(outDir, entries, { onProgress = () => {} } = {}) {
  const phase = `Writing local dump ${outDir}`;
  onProgress({ phase, completed: 0, total: entries.length });
  const filesDir = path.join(outDir, 'files');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  const manifest = [];
  const directories = directoryPaths(entries.map((entry) => entry.rel));
  for (const { body, ...entry } of entries) {
    if (body) {
      entry.bodyFile = await saveBody(outDir, { ...entry, body }, directories);
    }
    manifest.push(entry);
    onProgress({ phase, completed: manifest.length, total: entries.length, key: entry.key });
  }
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/**
 * Reads a dump back, loading bodies into `body` Buffers.
 */
export async function readDump(outDir, { onProgress = () => {}, withBodies = true } = {}) {
  try {
    const snapshot = JSON.parse(await fs.readFile(path.join(outDir, 'snapshot.json'), 'utf8'));
    if (!snapshot.complete) throw new Error(`Snapshot is incomplete: ${outDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const phase = `Reading local dump ${outDir}`;
  onProgress({ phase });
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  let completed = 0;
  onProgress({ phase, completed, total: manifest.length });
  return Promise.all(manifest.map(async (entry) => {
    const result = withBodies && entry.bodyFile
      ? { ...entry, body: await fs.readFile(path.join(outDir, entry.bodyFile)) }
      : entry;
    completed += 1;
    onProgress({ phase, completed, total: manifest.length, key: entry.key });
    return result;
  }));
}
