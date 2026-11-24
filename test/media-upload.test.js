import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uploadImage } from '../src/media-upload.js';
import { mediaHash } from '../src/media.js';

const scope = { org: 'org', hlx6Site: 'target', hlx6ContentBusId: 'b'.repeat(59) };
const mediaOptions = {
  scope,
  client: { async send() { throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } }); } },
};

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
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'test-token',
      fetchImpl,
    });
    assert.equal(result.relativeUrl, './media_abc123.jpg');
    assert.equal(result.bytes, 5);
    assert.equal(result.reused, false);
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
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'media-token',
      daSourceToken: 'da-read-token',
      fetchImpl,
    });
    assert.deepEqual(requests[0].headers, { authorization: 'Bearer da-read-token' });
  });

  it('never forwards the DA token to lookalike hosts or other origins', async () => {
    for (const imageUrl of [
      'https://evilcontent.da.live/org/site/a.png',
      'https://content.da.live.evil.example/org/site/a.png',
      'http://content.da.live/org/site/a.png',
      'https://content.da.live:8443/org/site/a.png',
    ]) {
      const requests = [];
      await uploadImage(imageUrl, {
        ...mediaOptions,
        apiUrl: 'https://api.aem.live/org/sites/target/media/',
        mediaToken: 'media-token', daSourceToken: 'da-read-token',
        fetchImpl: async (url, options) => {
          requests.push({ url, headers: options.headers });
          return url.includes('/media/')
            ? response({ json: { uri: 'https://main--target--org.aem.page/media_a.png' } })
            : response({ contentType: 'image/png' });
        },
      });
      assert.deepEqual(requests[0].headers, {});
      assert.equal(requests[1].headers.authorization, 'Bearer media-token');
    }
  });

  it('requires media API credentials and rejects oversized images before upload', async () => {
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      fetchImpl: async () => response(),
    }), /API token/);
    let calls = 0;
    await assert.rejects(uploadImage('https://images.example/large.jpg', {
      ...mediaOptions,
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
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => response({ ok: false, status: 404 }),
    }), /Image fetch failed/);
    let calls = 0;
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => (++calls === 1
        ? response()
        : response({ ok: false, status: 409 })),
    }), /Media API upload failed/);
    calls = 0;
    await assert.rejects(uploadImage('https://images.example/a.jpg', {
      ...mediaOptions,
      apiUrl: 'https://api.aem.live/org/sites/target/media/',
      mediaToken: 'token',
      fetchImpl: async () => (++calls === 1 ? response() : response({ json: {} })),
    }), /no uri/);
  });

  it('reuses a large snapshot image by target hash without a fetch or upload', async () => {
    const body = Buffer.alloc(5_000_001, 7);
    const requests = [];
    const result = await uploadImage('https://content.da.live/org/source/photo.png', {
      scope, mediaToken: 'token', apiUrl: 'https://api.aem.live/org/sites/target/media/',
      sourceImage: { body, contentType: 'image/jpeg' },
      client: { async send(command) {
        requests.push(command.input);
        assert.equal(command.constructor.name, 'HeadObjectCommand');
        return { ContentType: 'image/jpeg; charset=binary', ContentLength: body.length };
      } },
      fetchImpl: () => { throw new Error('Existing snapshot media must not be fetched or uploaded'); },
    });
    assert.deepEqual(requests, [{ Bucket: 'helix-media-bus', Key: `${scope.hlx6ContentBusId}/${mediaHash(body)}` }]);
    assert.equal(result.reused, true);
    assert.equal(result.relativeUrl, `./media_${mediaHash(body)}.jpg`);
    assert.equal(result.bytes, body.length);
  });

  it('coalesces concurrent aliases into one lookup and one upload on a 404', async () => {
    const mediaCache = new Map();
    const body = Buffer.from('same image');
    let heads = 0;
    let uploads = 0;
    const options = {
      ...mediaOptions, mediaCache, mediaToken: 'token', apiUrl: 'https://api.aem.live/org/sites/target/media/',
      sourceImage: { body, contentType: 'image/png' },
      client: { async send(command) {
        assert.equal(command.constructor.name, 'HeadObjectCommand');
        heads += 1;
        throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
      } },
      fetchImpl: async (url, options) => {
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.body, body);
        uploads += 1;
        return response({ json: { uri: 'https://main--target--org.aem.page/media_hash.png' } });
      },
    };
    const results = await Promise.all(['a', 'b'].map((name) => uploadImage(`https://images.example/${name}.png`, options)));
    assert.equal(heads, 1);
    assert.equal(uploads, 1);
    assert.deepEqual(results.map(({ reused }) => reused), [false, true]);
    assert.equal(results[0].relativeUrl, results[1].relativeUrl);
  });

  it('reuses existing TIFF media above the regular upload limit', async () => {
    const body = Buffer.alloc(5_000_001);
    const result = await uploadImage('https://content.da.live/org/source/photo.tif', {
      scope, mediaToken: 'token', apiUrl: 'https://api.aem.live/org/sites/target/media/',
      sourceImage: { body, contentType: 'image/tiff' },
      client: { async send() { return { ContentType: 'image/tiff', ContentLength: body.length }; } },
      fetchImpl: () => { throw new Error('Existing TIFF must not be uploaded'); },
    });
    assert.equal(result.reused, true);
    assert.equal(result.relativeUrl, `./media_${mediaHash(body)}.tif`);
  });

  it('never uploads after authorization, service, network or invalid-media lookup failures', async () => {
    for (const scenario of [403, 503, 'network', 'length', 'type']) {
      await assert.rejects(uploadImage('https://images.example/a.png', {
        scope, mediaToken: 'token', apiUrl: 'https://api.aem.live/org/sites/target/media/',
        sourceImage: { body: Buffer.from('image'), contentType: 'image/png' },
        client: { async send() {
          if (scenario === 'length') return { ContentType: 'image/png', ContentLength: 99 };
          if (scenario === 'type') return { ContentType: 'application/octet-stream', ContentLength: 5 };
          throw Object.assign(new Error(`lookup-${scenario}`), typeof scenario === 'number'
            ? { $metadata: { httpStatusCode: scenario } } : {});
        } },
        fetchImpl: () => { assert.fail('Only a 404 may trigger an upload'); },
      }), /lookup-|Unsupported existing media content type|Existing media length mismatch/);
    }
  });
});