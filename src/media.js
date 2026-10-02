import crypto from 'node:crypto';

/**
 * Media bus name of a resource, as computed by @adobe/helix-mediahandler (alg "8k"):
 * "1" + sha1(contentLength + first 8 KiB).
 * @param {Buffer} buffer full resource bytes
 * @returns {string} e.g. `14bee32b7222199474e7654ca6c19dcdb05f59c86`
 */
export function mediaHash(buffer) {
  const hex = crypto.createHash('sha1')
    .update(String(buffer.length))
    .update(buffer.subarray(0, 8192))
    .digest('hex');
  return `1${hex}`;
}
