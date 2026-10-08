import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import processQueue from '@adobe/helix-shared-process-queue';
import { listAll, headObject, putObject } from './storage.js';
import { collectExternalImageUrls, rewriteImageUrls } from './migration.js';
import { uploadImage } from './media-upload.js';

const SOURCE_BUCKET = 'helix-source-bus';
const IMAGE_CONCURRENCY = 4;
const WRITE_CONCURRENCY = 8;

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function ownerMetadata(object) {
  return object.kind === 'version'
    ? ['da-version-id', object.metadata['da-version-id']]
    : ['da-id', object.metadata['da-id']];
}

function belongsToMigration(head, object) {
  const [key, value] = ownerMetadata(object);
  return Boolean(value)
    && head.metadata?.[key] === value
    && head.metadata?.['da-source-sha256'] === sha256(object.body);
}

export async function inspectDestination(client, scope, objects, {
  overwrite = false, onProgress = () => {},
} = {}) {
  const prefix = `${scope.org}/${scope.hlx6Site}/`;
  const existing = await listAll(client, SOURCE_BUCKET, prefix, { onProgress });
  const planKeys = new Set(objects.map((object) => object.key));
  const unexpected = existing.filter((object) => !planKeys.has(object.key));
  if (unexpected.length) {
    throw new Error(`Destination contains unplanned objects; refusing to write: ${unexpected.map((object) => object.key).join(', ')}`);
  }

  const existingKeys = new Set(existing.map((object) => object.key));
  const statuses = new Map();
  const progress = (object) => onProgress({
    phase: 'Checking destination conflicts', completed: statuses.size, total: objects.length,
    key: object.key, status: statuses.get(object.key),
  });
  onProgress({ phase: 'Checking destination conflicts', completed: 0, total: objects.length });
  for (const object of objects) {
    if (!existingKeys.has(object.key)) {
      statuses.set(object.key, 'planned');
      progress(object);
      continue;
    }
    if (overwrite) {
      statuses.set(object.key, 'overwrite');
      progress(object);
      continue;
    }
    const head = await headObject(client, SOURCE_BUCKET, object.key);
    if (!belongsToMigration(head, object)) {
      throw new Error(`Destination key exists but is not an identical migration object: ${object.key}`);
    }
    statuses.set(object.key, 'exists');
    progress(object);
  }
  return statuses;
}

async function prepareImages(objects, { scope, mediaToken, daSourceToken, fetchImpl, onProgress }) {
  const urls = [...new Set(objects
    .filter((object) => object.contentType === 'text/html')
    .flatMap((object) => collectExternalImageUrls(object.body.toString('utf8'), scope.org, scope.hlx6Site)))];
  if (urls.length && !mediaToken) {
    throw new Error(`External images require an API token (${urls.length} distinct URL(s))`);
  }
  const replacements = new Map();
  const total = urls.length;
  onProgress({ phase: 'Uploading external images', completed: 0, total });
  const apiUrl = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}/media/`;
  await processQueue(urls, async (url) => {
    const uploaded = await uploadImage(url, {
      apiUrl,
      mediaToken,
      daSourceToken,
      fetchImpl,
    });
    replacements.set(url, uploaded.relativeUrl);
    onProgress({ phase: 'Uploading external images', completed: replacements.size, total });
  }, IMAGE_CONCURRENCY);
  return replacements;
}

function prepareObject(object, replacements, scope) {
  const body = object.contentType === 'text/html'
    ? Buffer.from(rewriteImageUrls(object.body.toString('utf8'), replacements, scope.org, scope.hlx6Site))
    : object.body;
  return {
    ...object,
    body,
    metadata: {
      ...object.metadata,
      'uncompressed-length': String(body.length),
      'da-source-sha256': sha256(object.body),
    },
  };
}

function writeRank(kind) {
  return ({ version: 0, doc: 1, sheet: 1, media: 1, trash: 1, folder: 2 })[kind] ?? 3;
}

/**
 * Executes or plans the sample migration. Overwrites require explicit opt-in; no deletes.
 */
export async function runMigration(plan, {
  client,
  scope,
  execute = false,
  overwrite = false,
  mediaToken,
  daSourceToken,
  fetchImpl,
  onProgress = () => {},
}) {
  const statuses = await inspectDestination(client, scope, plan.objects, { overwrite, onProgress });
  if (!execute) {
    onProgress({ phase: 'Collecting external image URLs (dry run; no uploads)' });
    return {
      dryRun: true,
      statuses,
      imageUrls: [...new Set(plan.objects
        .filter((object) => object.contentType === 'text/html')
        .flatMap((object) => collectExternalImageUrls(object.body.toString('utf8'), scope.org, scope.hlx6Site)))],
      objects: plan.objects.length,
    };
  }

  const replacements = await prepareImages(plan.objects, {
    scope, mediaToken, daSourceToken, fetchImpl, onProgress,
  });
  onProgress({ phase: 'Preparing target objects' });
  const objects = plan.objects.map((object) => prepareObject(object, replacements, scope));
  const ranks = [...new Set(objects.map((object) => writeRank(object.kind)))].sort((a, b) => a - b);
  const results = [];
  let completed = 0;
  const total = objects.filter((object) => statuses.get(object.key) !== 'exists').length;
  const written = (object, status) => {
    completed += 1;
    onProgress({ phase: 'Writing target objects', completed, total, key: object.key, status, kind: object.kind });
  };
  onProgress({ phase: 'Writing target objects', completed, total });
  for (const rank of ranks) {
    const stage = objects.filter((object) => writeRank(object.kind) === rank
      && statuses.get(object.key) !== 'exists');
    const stageResults = await processQueue(stage, async (object) => {
      const input = {
        Bucket: SOURCE_BUCKET,
        Key: object.key,
        Body: object.contentEncoding === 'gzip' ? gzipSync(object.body) : object.body,
        ContentType: object.contentType,
        Metadata: object.metadata,
        ...(!overwrite && { IfNoneMatch: '*' }),
        ...(object.contentEncoding && { ContentEncoding: object.contentEncoding }),
      };
      try {
        await putObject(client, scope, input);
        written(object, 'written');
        return { key: object.key, status: 'written', kind: object.kind };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 412) {
          const head = await headObject(client, SOURCE_BUCKET, object.key);
          if (belongsToMigration(head, object)) {
            written(object, 'exists');
            return { key: object.key, status: 'exists', kind: object.kind };
          }
        }
        throw error;
      }
    }, WRITE_CONCURRENCY);
    results.push(...stageResults);
  }
  return {
    dryRun: false,
    statuses,
    imageUrls: [...replacements.keys()],
    objects: plan.objects.length,
    results,
  };
}