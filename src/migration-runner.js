import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import processQueue from '@adobe/helix-shared-process-queue';
import { listAll, headObject, putObject } from './storage.js';
import { collectExternalImageUrls, rewriteImageUrls } from './migration.js';
import { uploadImage } from './media-upload.js';
import { rewriteDaBody, rewriteDaUrls } from './da-urls.js';

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
  overwrite = false, requireEmpty = false, onProgress = () => {},
} = {}) {
  const prefix = `${scope.org}/${scope.hlx6Site}/`;
  const existing = await listAll(client, SOURCE_BUCKET, prefix, { onProgress });
  if (requireEmpty && existing.length && !overwrite) {
    throw new Error(`HLX6 target contains objects under ${SOURCE_BUCKET}/${prefix}; execution requires --overwrite`);
  }
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

async function prepareImages(objects, { client, scope, mediaToken, daSourceToken, fetchImpl, onProgress, onImageError, onImageUploaded, onImageReused }) {
  const references = new Map();
  objects.filter((object) => object.contentType === 'text/html').forEach((object) => {
    collectExternalImageUrls(object.body.toString('utf8'), scope.org, scope.hlx6Site).forEach((url) => {
      if (!references.has(url)) references.set(url, new Set());
      references.get(url).add(object.sourceKey || object.key);
    });
  });
  const urls = [...references.keys()];
  if (urls.length && !mediaToken) {
    throw new Error(`Images require an API token (${urls.length} distinct URL(s))`);
  }
  if (urls.length && !scope.hlx6ContentBusId) {
    throw new Error('Image reuse requires a target content bus ID');
  }
  const sourceImages = new Map(objects
    .filter((object) => object.sourceKey && object.contentType?.startsWith('image/'))
    .map((object) => [object.sourceKey, object]));
  const mediaCache = new Map();
  const replacements = new Map();
  const imageErrors = [];
  const uploadedImageUrls = [];
  const reusedImageUrls = [];
  let completed = 0;
  const total = urls.length;
  const progress = () => onProgress({
    phase: 'Uploading images', completed, total,
    reused: reusedImageUrls.length, uploaded: uploadedImageUrls.length, failed: imageErrors.length,
  });
  progress();
  const apiUrl = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}/media/`;
  await processQueue([...urls], async (url) => {
    try {
      const parsed = new URL(url);
      const sourceImage = parsed.origin === 'https://content.da.live'
        ? sourceImages.get(decodeURIComponent(parsed.pathname.slice(1))) : undefined;
      const uploaded = await uploadImage(url, {
        apiUrl, mediaToken, daSourceToken, fetchImpl, client, scope, sourceImage, mediaCache,
      });
      replacements.set(url, uploaded.relativeUrl);
      if (uploaded.reused) {
        reusedImageUrls.push(url);
        onImageReused(url);
      } else {
        uploadedImageUrls.push(url);
        onImageUploaded(url);
      }
    } catch (error) {
      const { value: targetUrl } = rewriteDaUrls(url, scope);
      const action = targetUrl === url ? 'kept-original-url' : 'rewritten-to-source-api';
      const failure = {
        url, error: error.message, sourceKeys: [...references.get(url)], action,
        ...(targetUrl !== url && { targetUrl }),
      };
      imageErrors.push(failure);
      onImageError(failure);
      onProgress({ phase: `Image upload failed; ${action}`, key: url, status: action, error: error.message });
    }
    completed += 1;
    progress();
  }, IMAGE_CONCURRENCY);
  return { replacements, imageErrors, urls, uploadedImageUrls, reusedImageUrls };
}

/**
 * Applies successful image uploads, then DA URL rewrites, retaining original-body provenance.
 * @param {object} object Planned source object.
 * @param {Map<string,string>} replacements Successful image URL replacements.
 * @param {object} scope Migration scope.
 * @returns {object} Prepared body, byte length, source hash and applied URL rewrites.
 */
function prepareObject(object, replacements, scope) {
  const imageBody = object.contentType === 'text/html'
    ? Buffer.from(rewriteImageUrls(object.body.toString('utf8'), replacements, scope.org, scope.hlx6Site))
    : object.body;
  const { body, rewrites } = rewriteDaBody({ ...object, body: imageBody }, scope);
  return {
    ...object,
    body,
    urlRewrites: rewrites.map((item) => ({ key: object.sourceKey || object.key, ...item })),
    metadata: {
      ...object.metadata,
      'uncompressed-length': String(body.length),
      'da-source-sha256': sha256(object.body),
    },
  };
}

function writeRank(kind) {
  return ({ version: 0, audit: 1, doc: 2, sheet: 2, media: 2, trash: 2, folder: 3 })[kind] ?? 4;
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
  onImageError = () => {},
  onImageUploaded = () => {},
  onImageReused = () => {},
}) {
  const statuses = await inspectDestination(client, scope, plan.objects, { overwrite, requireEmpty: execute, onProgress });
  if (!execute) {
    onProgress({ phase: 'Collecting image upload candidates (dry run; no uploads)' });
    return {
      dryRun: true,
      statuses,
      imageUrls: [...new Set(plan.objects
        .filter((object) => object.contentType === 'text/html')
        .flatMap((object) => collectExternalImageUrls(object.body.toString('utf8'), scope.org, scope.hlx6Site)))],
      imageErrors: [],
      uploadedImageUrls: [],
      reusedImageUrls: [],
      objects: plan.objects.length,
      urlRewrites: plan.urlRewrites || plan.objects.flatMap((object) => (
        rewriteDaBody(object, scope).rewrites.map((item) => ({ key: object.sourceKey || object.key, ...item }))
      )),
    };
  }

  const { replacements, imageErrors, urls, uploadedImageUrls, reusedImageUrls } = await prepareImages(plan.objects, {
    client, scope, mediaToken, daSourceToken, fetchImpl, onProgress, onImageError, onImageUploaded, onImageReused,
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
          if (belongsToMigration(head, plan.objects.find(({ key }) => key === object.key))) {
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
    imageUrls: urls,
    uploadedImageUrls,
    reusedImageUrls,
    imageErrors,
    urlRewrites: objects.flatMap((object) => object.urlRewrites),
    objects: plan.objects.length,
    results,
  };
}