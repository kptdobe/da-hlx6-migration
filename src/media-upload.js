const MAX_REGULAR_UPLOAD_BYTES = 5_000_000;

/**
 * Fetches an external image and uploads it through the hlx6 media API.
 * @param {string} imageUrl
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.mediaToken
 * @param {string} [opts.daSourceToken]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{relativeUrl:string, uri:string, contentType:string, bytes:number}>}
 */
export async function uploadImage(imageUrl, {
  apiUrl,
  mediaToken,
  daSourceToken,
  fetchImpl = fetch,
}) {
  if (!mediaToken) throw new Error('HLX6_MEDIA_TOKEN is required to upload images');

  const imageHeaders = {};
  if (daSourceToken && new URL(imageUrl).hostname.endsWith('content.da.live')) {
    imageHeaders.authorization = `Bearer ${daSourceToken}`;
  }
  const imageResponse = await fetchImpl(imageUrl, { headers: imageHeaders });
  if (!imageResponse.ok) throw new Error(`Image fetch failed (${imageResponse.status}): ${imageUrl}`);
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
  if (imageBytes.length > MAX_REGULAR_UPLOAD_BYTES) {
    throw new Error(`Image exceeds the regular media API upload limit (${imageBytes.length} bytes): ${imageUrl}`);
  }
  const contentType = imageResponse.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image (${contentType}): ${imageUrl}`);

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
  };
}