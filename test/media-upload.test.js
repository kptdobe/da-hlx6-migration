import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uploadImage } from '../src/media-upload.js';

function response({ ok = true, status = 200, body = Buffer.from('image'), contentType = 'image/jpeg', json } = {}) {
  return {
    ok,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => body,
    json: async () => json,
  };
}

describe('uploadImage', () => {
  it('fetches image bytes and registers them with the target media API', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (requests.length === 1) return response();
      return response({ json: { uri: 'https://main--target--org.aem.page/media_abc123.jpg' } });
    };
    const result = await uploadImage('https://images.example/a.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'test-token',
      fetchImpl,
    });
    assert.equal(result.relativeUrl, './media_abc123.jpg');
    assert.equal(result.bytes, 5);
    assert.equal(requests[1].url, 'https://api.aem.live/org/sites/target/media/');
    assert.equal(requests[1].options.headers.authorization, 'Bearer test-token');
    assert.equal(requests[1].options.headers['content-type'], 'image/jpeg');
  });

  it('uses the DA read token only for content.da.live images', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, headers: options.headers });
      return url.includes('/media/')
        ? response({ json: { uri: 'https://main--target--org.aem.page/media_a.png' } })
        : response({ contentType: 'image/png' });
    };
    await uploadImage('https://content.da.live/org/site/a.png', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'media-token',
      daSourceToken: 'da-read-token',
      fetchImpl,
    });
    assert.deepEqual(requests[0].headers, { authorization: 'Bearer da-read-token' });
  });

  it('requires media API credentials and rejects oversized images before upload', async () => {
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      fetchImpl: async () => response(),
    }), /HLX6_MEDIA_TOKEN/);
    let calls = 0;
    await assert.rejects(uploadImage('https://images.example/large.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => {
        calls += 1;
        return response({ body: Buffer.alloc(5_000_001) });
      },
    }), /upload limit/);
    assert.equal(calls, 1);
  });

  it('reports fetch, API and malformed response failures', async () => {
    await assert.rejects(uploadImage('https://images.example/404.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => response({ ok: false, status: 404 }),
    }), /Image fetch failed/);
    let calls = 0;
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => (++calls === 1
        ? response()
        : response({ ok: false, status: 409 })),
    }), /Media API upload failed/);
    calls = 0;
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => (++calls === 1 ? response() : response({ json: {} })),
    }), /no uri/);
  });
});