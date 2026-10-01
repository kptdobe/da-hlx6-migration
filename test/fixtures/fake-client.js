import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * In-memory fake of an S3Client covering List/Head/Get.
 * @param {Record<string, {body: string|Buffer, contentType?: string, gzip?: boolean,
 *   metadata?: object, lastModified?: string}>} objects keyed by full key
 * @param {number} [pageSize]
 */
export function fakeClient(objects, pageSize = 1000) {
  const keys = Object.keys(objects).sort();
  const calls = [];
  const describe = (key) => {
    const o = objects[key];
    const raw = Buffer.from(o.body);
    const stored = o.gzip ? gzipSync(raw) : raw;
    return {
      o,
      stored,
      headers: {
        ContentType: o.contentType || 'text/html',
        ContentEncoding: o.gzip ? 'gzip' : undefined,
        ContentLength: stored.length,
        ETag: `"etag-${key}"`,
        LastModified: new Date(o.lastModified || '2026-01-01T00:00:00Z'),
        Metadata: o.metadata || {},
      },
    };
  };
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push(name);
      const { input } = cmd;
      if (name === 'ListObjectsV2Command') {
        const matching = keys.filter((k) => k.startsWith(input.Prefix));
        const start = Number(input.ContinuationToken || 0);
        const page = matching.slice(start, start + pageSize);
        const next = start + pageSize;
        return {
          Contents: page.map((k) => {
            const { stored, headers } = describe(k);
            return {
              Key: k, Size: stored.length, ETag: headers.ETag, LastModified: headers.LastModified,
            };
          }),
          IsTruncated: next < matching.length,
          NextContinuationToken: next < matching.length ? String(next) : undefined,
        };
      }
      if (!objects[input.Key]) {
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      const { stored, headers } = describe(input.Key);
      if (name === 'HeadObjectCommand') return headers;
      if (name === 'GetObjectCommand') {
        const body = Readable.from([stored]);
        body.transformToByteArray = async () => new Uint8Array(stored);
        return { ...headers, Body: body };
      }
      throw new Error(`Unsupported command ${name}`);
    },
  };
}
