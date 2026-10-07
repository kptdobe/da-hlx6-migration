import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { getDaAuthToken } from '../src/auth.js';

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
