import { mediaHash } from './media.js';
import { headObject } from './storage.js';
import { MEDIA_BUS } from './scope.js';

const MAX_REGULAR_UPLOAD_BYTES = 5_000_000;
const IMAGE_EXTENSIONS = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/**
 * Reuses target media by hash, uploading only missing images through the media API.
 * @param {string} imageUrl
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.mediaToken
 * @param {object} opts.client Target-scoped storage client.
 * @param {object} opts.scope Migration scope including hlx6ContentBusId.
 * @param {{body:Buffer, contentType:string}} [opts.sourceImage] Original snapshot image.
 * @param {Map<string,Promise<object>>} [opts.mediaCache] Shared in-flight hash lookups/uploads.
 * @param {string} [opts.daSourceToken]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{relativeUrl:string, uri:string, contentType:string, bytes:number, reused:boolean}>}
 */
export async function uploadImage(imageUrl, {
  apiUrl,
  mediaToken,
  client,
  scope,
  sourceImage,
  mediaCache = new Map(),
  daSourceToken,
  fetchImpl = fetch,
}) {
  if (!mediaToken) throw new Error('An API token is required to upload images');
  if (!client || !/^[0-9a-f]{32,64}$/.test(scope?.hlx6ContentBusId || '')) {
    throw new Error('Image reuse requires a storage client and valid target content bus ID');
  }

  let { body: imageBytes, contentType } = sourceImage || {};
  if (!sourceImage) {
    const imageHeaders = {};
    if (daSourceToken && new URL(imageUrl).origin === 'https://content.da.live') {
      imageHeaders.authorization = `Bearer ${daSourceToken}`;
    }
    const imageResponse = await fetchImpl(imageUrl, { headers: imageHeaders });
    if (!imageResponse.ok) throw new Error(`Image fetch failed (${imageResponse.status}): ${imageUrl}`);
    imageBytes = Buffer.from(await imageResponse.arrayBuffer());
    contentType = imageResponse.headers.get('content-type');
  }
  contentType = contentType?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image (${contentType}): ${imageUrl}`);

  const hash = mediaHash(imageBytes);
  const key = `${scope.hlx6ContentBusId}/${hash}`;
  if (mediaCache.has(key)) {
    return { ...await mediaCache.get(key), reused: true };
  }
  const pending = (async () => {
    let existing;
    try {
      existing = await headObject(client, MEDIA_BUS, key);
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
    }
    if (existing) {
      const storedType = existing.contentType?.split(';')[0].trim().toLowerCase();
      const extension = IMAGE_EXTENSIONS[storedType];
      if (!extension) throw new Error(`Unsupported existing media content type "${existing.contentType}": s3://${MEDIA_BUS}/${key}`);
      if (existing.contentLength !== imageBytes.length) {
        throw new Error(`Existing media length mismatch (${existing.contentLength} stored, ${imageBytes.length} expected): s3://${MEDIA_BUS}/${key}`);
      }
      const filename = `media_${hash}.${extension}`;
      return {
        relativeUrl: `./${filename}`,
        uri: `https://main--${scope.hlx6Site}--${scope.org}.aem.page/${filename}`,
        contentType: storedType,
        bytes: imageBytes.length,
        reused: true,
      };
    }
    if (imageBytes.length > MAX_REGULAR_UPLOAD_BYTES) {
      throw new Error(`Image exceeds the regular media API upload limit (${imageBytes.length} bytes): ${imageUrl}`);
    }
    const uploadResponse = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mediaToken}`,
        'content-type': contentType,
      },
      body: imageBytes,
    });
    if (!uploadResponse.ok) {
      throw new Error(`Media API upload failed (${uploadResponse.status}): ${imageUrl}`);
    }
    const result = await uploadResponse.json();
    if (!result.uri) throw new Error(`Media API response has no uri: ${imageUrl}`);
    const filename = new URL(result.uri).pathname.split('/').at(-1);
    if (!/^media_[a-z0-9]+\.[a-z0-9]+$/i.test(filename)) {
      throw new Error(`Unexpected media API URI: ${result.uri}`);
    }
    return {
      relativeUrl: `./${filename}`,
      uri: result.uri,
      contentType,
      bytes: imageBytes.length,
      reused: false,
    };
  })();
  mediaCache.set(key, pending);
  return pending;
}