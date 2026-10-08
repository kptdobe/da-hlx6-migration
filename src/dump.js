import fs from 'node:fs/promises';
import path from 'node:path';
import processQueue from '@adobe/helix-shared-process-queue';
import { listSharded, getObject, headObject } from './storage.js';
import { classifyDa, classifyHlx6 } from './classify.js';

const CLASSIFIERS = { da: classifyDa, hlx6: classifyHlx6 };

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
  onProgress = () => {}, listingConcurrency = 8,
}) {
  const prefix = `${org}/${site}/`;
  const classify = CLASSIFIERS[backend];
  const listed = await listSharded(client, bucket, prefix, { onProgress, concurrency: listingConcurrency });
  const total = listed.length;
  let completed = 0;
  let bytes = 0;
  const phase = `${withBodies ? 'Downloading' : 'Reading headers'} ${backend} ${org}/${site}`;
  onProgress({ phase, completed, total, bytes });
  const entries = await processQueue(listed, async (obj) => {
    const rel = `/${obj.key.slice(prefix.length)}`;
    const res = withBodies
      ? await getObject(client, bucket, obj.key)
      : await headObject(client, bucket, obj.key);
    completed += 1;
    bytes += withBodies ? res.body.length : 0;
    onProgress({ phase, completed, total, bytes, key: obj.key });
    return {
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
  }, concurrency);
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Writes scan results to `outDir/manifest.json` and bodies under `outDir/files/`.
 */
export async function writeDump(outDir, entries, { onProgress = () => {} } = {}) {
  const phase = `Writing local dump ${outDir}`;
  onProgress({ phase, completed: 0, total: entries.length });
  const filesDir = path.join(outDir, 'files');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(filesDir, { recursive: true });
  const manifest = [];
  for (const { body, ...entry } of entries) {
    if (body) {
      const file = path.join(filesDir, entry.rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
      entry.bodyFile = path.join('files', entry.rel);
    }
    manifest.push(entry);
    onProgress({ phase, completed: manifest.length, total: entries.length, key: entry.key });
  }
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Reads a dump back, loading bodies into `body` Buffers.
 */
export async function readDump(outDir, { onProgress = () => {} } = {}) {
  const phase = `Reading local dump ${outDir}`;
  onProgress({ phase });
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  let completed = 0;
  onProgress({ phase, completed, total: manifest.length });
  return Promise.all(manifest.map(async (entry) => {
    const result = entry.bodyFile
      ? { ...entry, body: await fs.readFile(path.join(outDir, entry.bodyFile)) }
      : entry;
    completed += 1;
    onProgress({ phase, completed, total: manifest.length, key: entry.key });
    return result;
  }));
}
