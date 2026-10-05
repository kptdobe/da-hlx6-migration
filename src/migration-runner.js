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

export async function inspectDestination(client, scope, objects) {
  const prefix = `${scope.org}/${scope.hlx6Site}/`;
  const existing = await listAll(client, SOURCE_BUCKET, prefix);
  const planKeys = new Set(objects.map((object) => object.key));
  const unexpected = existing.filter((object) => !planKeys.has(object.key));
  if (unexpected.length) {
    throw new Error(`Destination contains unplanned objects; refusing to write: ${unexpected.map((object) => object.key).join(', ')}`);
  }

  const existingKeys = new Set(existing.map((object) => object.key));
  const statuses = new Map();
  for (const object of objects) {
    if (!existingKeys.has(object.key)) {
      statuses.set(object.key, 'planned');
      continue;
    }
    const head = await headObject(client, SOURCE_BUCKET, object.key);
    if (!belongsToMigration(head, object)) {
      throw new Error(`Destination key exists but is not an identical migration object: ${object.key}`);
    }
    statuses.set(object.key, 'exists');
  }
  return statuses;
}

async function prepareImages(objects, { scope, mediaToken, daSourceToken, fetchImpl }) {
  const urls = [...new Set(objects
    .filter((object) => object.contentType === 'text/html')
    .flatMap((object) => collectExternalImageUrls(object.body.toString('utf8'), scope.org, scope.hlx6Site)))];
  if (urls.length && !mediaToken) {
    throw new Error(`External images require HLX6_MEDIA_TOKEN (${urls.length} distinct URL(s))`);
  }
  const replacements = new Map();
  const apiUrl = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}/media/`;
  await processQueue(urls, async (url) => {
    const uploaded = await uploadImage(url, {
      apiUrl,
      mediaToken,
      daSourceToken,
      fetchImpl,
    });
    replacements.set(url, uploaded.relativeUrl);
  }, IMAGE_CONCURRENCY);
  return replacements;
}

function prepareObject(object, replacements) {
  const body = object.contentType === 'text/html'
    ? Buffer.from(rewriteImageUrls(object.body.toString('utf8'), replacements))
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
 * Executes or plans the sample migration. No delete or overwrite operation exists.
 */
export async function runMigration(plan, {
  client,
  scope,
  execute = false,
  mediaToken,
  daSourceToken,
  fetchImpl,
  onProgress = () => {},
}) {
  const statuses = await inspectDestination(client, scope, plan.objects);
  if (!execute) {
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
    scope, mediaToken, daSourceToken, fetchImpl,
  });
  const objects = plan.objects.map((object) => prepareObject(object, replacements));
  const ranks = [...new Set(objects.map((object) => writeRank(object.kind)))].sort((a, b) => a - b);
  const results = [];
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
        IfNoneMatch: '*',
        ...(object.contentEncoding && { ContentEncoding: object.contentEncoding }),
      };
      try {
        await putObject(client, scope, input);
        onProgress({ key: object.key, status: 'written', kind: object.kind });
        return { key: object.key, status: 'written', kind: object.kind };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 412) {
          const head = await headObject(client, SOURCE_BUCKET, object.key);
          if (belongsToMigration(head, object)) {
            onProgress({ key: object.key, status: 'exists', kind: object.kind });
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