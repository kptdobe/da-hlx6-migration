import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { getDaAuthToken, readDaSession, createDaAuth } from '../src/auth.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('getDaAuthToken', () => {
  it('uses the configured DA token without starting the helper', () => {
    const previous = process.env.DA_CONFIG_TOKEN;
    process.env.DA_CONFIG_TOKEN = 'configured-token';
    let helperStarted = false;
    try {
      assert.equal(getDaAuthToken({ execute: () => { helperStarted = true; } }), 'configured-token');
      assert.equal(helperStarted, false);
    } finally {
      if (previous === undefined) delete process.env.DA_CONFIG_TOKEN;
      else process.env.DA_CONFIG_TOKEN = previous;
    }
  });

  describe('saved DA sessions', () => {
    const expires = Date.now() + 3_600_000;
    const expiresAt = new Date(expires).toISOString();
    const cached = { token: 'private-cached-token', expiresAt, source: 'cache' };
    const unexpectedLogin = () => { throw new Error('Must not start or clear login'); };
    const jwt = (exp) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;

    it('reads the helper cache expiry and uses token expiry when it is earlier', async () => {
      const token = jwt(Math.floor((expires - 60_000) / 1000));
      const session = await readDaSession({
        token: '',
        readFile: async () => JSON.stringify({ access_token: token, expires_at: expires }),
      });
      assert.equal(session.token, token);
      assert.equal(session.expiresAt, new Date(Math.floor((expires - 60_000) / 1000) * 1000).toISOString());
      assert.equal(session.source, 'cache');
    });

    it('supports known and unknown environment token expiry without accessing the cache', async () => {
      const readFile = () => { throw new Error('Must not read cache for an override'); };
      const known = await readDaSession({ token: jwt(Math.floor(expires / 1000)), readFile });
      assert.equal(known.expiresAt, new Date(Math.floor(expires / 1000) * 1000).toISOString());
      const opaque = await readDaSession({ token: 'opaque-token', readFile });
      assert.equal(opaque.expiresAt, null);
      const malformed = await readDaSession({ token: 'header.not-json.signature', readFile });
      assert.equal(malformed.expiresAt, null);
    });

    it('distinguishes a missing cache from unreadable or malformed cache errors without leaking tokens', async () => {
      assert.equal(await readDaSession({
        token: '', readFile: async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
      }), null);
      await assert.rejects(readDaSession({
        token: '', readFile: async () => { throw Object.assign(new Error('private-detail'), { code: 'EACCES' }); },
      }), { message: /Could not read the saved DA session/ });
      for (const text of ['{"private-token"', '{"access_token":12}', '{"access_token":"private-token","expires_at":"invalid"}']) {
        await assert.rejects(readDaSession({ token: '', readFile: async () => text }), (error) => {
          assert.match(error.message, /saved DA session/);
          assert.doesNotMatch(error.message, /private-token/);
          return true;
        });
      }
    });

    it('restores a reusable token across auth instances without forcing browser sign-in', async () => {
      for (let restart = 0; restart < 2; restart += 1) {
        const auth = createDaAuth({
          cachedTokenProvider: async () => cached, tokenProvider: unexpectedLogin, clearToken: unexpectedLogin,
        });
        assert.equal((await auth.restore()).status, 'authenticated');
        assert.equal(auth.getStatus().expiresAt, expiresAt);
        assert.equal(auth.getStatus().refreshable, false);
        assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-cached-token/);
        auth.requireSignIn();
        assert.equal((await auth.restore()).status, 'required');
      }
    });

    it('requires sign-in for expired, near-expiry or legacy cached tokens and tracks expiry while idle', async () => {
      for (const session of [
        null, { ...cached, expiresAt: new Date(0).toISOString() },
        { ...cached, expiresAt: new Date(Date.now() + 30_000).toISOString() },
        { ...cached, expiresAt: null },
      ]) {
        const auth = createDaAuth({ cachedTokenProvider: async () => session, tokenProvider: unexpectedLogin });
        assert.equal((await auth.restore()).status, 'required');
      }
      let time = expires - 120_000;
      const auth = createDaAuth({ cachedTokenProvider: async () => cached, now: () => time });
      assert.equal((await auth.restore()).status, 'authenticated');
      time += 60_000;
      assert.equal((await auth.restore()).status, 'required');
      assert.equal(auth.getStatus().expiresAt, expiresAt);
    });

    it('exposes restore failures and fresh login expiry without retaining a stale restore result', async () => {
      let signedIn = false;
      const auth = createDaAuth({
        cachedTokenProvider: async () => {
          if (!signedIn) throw new Error('Saved DA session could not be read');
          return cached;
        },
        clearToken: async () => { signedIn = true; },
        tokenProvider: async ({ browserLogin }) => {
          assert.equal(browserLogin, true);
          return cached.token;
        },
      });
      assert.equal((await auth.restore()).status, 'failed');
      assert.match(auth.getStatus().error, /could not be read/);
      assert.equal(await auth.authenticate(true), cached.token);
      assert.equal((await auth.restore()).expiresAt, expiresAt);
      assert.equal((await auth.restore()).status, 'authenticated');
      assert.equal(auth.getStatus().error, undefined);
    });
  });

  it('gets and trims a token from the pinned project helper', () => {
    let invocation;
    const execute = (...args) => {
      invocation = args;
      return 'helper-token\n';
    };

    assert.equal(getDaAuthToken({ token: '', execute }), 'helper-token');
    assert.equal(invocation[0], 'npx');
    assert.deepEqual(invocation[1], ['--no-install', 'da-auth-helper', 'token']);
    assert.deepEqual(invocation[2], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
    });
  });
});
