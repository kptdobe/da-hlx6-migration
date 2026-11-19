import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createAwsAuth } from '../src/aws-auth.js';

const credentials = {
  accessKeyId: 'private-test-key', secretAccessKey: 'private-test-secret',
  sessionToken: 'private-test-token', expiration: new Date(Date.now() + 3_600_000),
};
const missing = () => { throw Object.assign(new Error('No credentials'), { name: 'CredentialsProviderError' }); };
const unexpectedLogin = () => { throw new Error('Must not start AWS CLI'); };

it('saves the browser login region before signing in without changing the existing default AWS profile', async (t) => {
  const previous = process.env.AWS_PROFILE;
  t.after(() => {
    if (previous === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = previous;
  });
  process.env.AWS_PROFILE = 'default';
  for (const method of ['signIn', 'credentials']) {
    const calls = [];
    let loggedIn = false;
    const auth = createAwsAuth({
      loadLoginCredentials: async () => (loggedIn ? credentials : missing()),
      loadCredentials: missing,
      validateCredentials: async () => {},
      execute: async (args) => {
        calls.push(args);
        assert.equal(process.env.AWS_PROFILE, 'default');
        if (args[0] === '--version') return 'aws-cli/2.41.1';
        if (args[0] === 'login') loggedIn = true;
      },
      onLogin() {},
    });
    assert.deepEqual(await auth[method](), credentials);
    assert.deepEqual(calls, [
      ['--version'],
      ['configure', 'set', 'region', 'us-east-1', '--profile', 'da-hlx6-migration-login'],
      ['login', '--profile', 'da-hlx6-migration-login', '--region', 'us-east-1'],
    ]);
  }
});

it('reports region configuration failures without starting browser login or exposing command details', async () => {
  const calls = [];
  const auth = createAwsAuth({
    execute: async (args) => {
      calls.push(args);
      if (args[0] === '--version') return 'aws-cli/2.41.1';
      throw new Error('private-test-secret');
    },
    onLogin: () => { throw new Error('Must not announce browser login'); },
  });
  await assert.rejects(auth.signIn(), /Could not configure.*profile region.*write permissions/);
  assert.deepEqual(calls, [
    ['--version'],
    ['configure', 'set', 'region', 'us-east-1', '--profile', 'da-hlx6-migration-login'],
  ]);
  assert.equal(auth.getStatus().status, 'failed');
  assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-test/);
});

it('reuses and validates a cached browser session without local keys or AWS CLI', async () => {
  const validated = [];
  const auth = createAwsAuth({
    loadLoginCredentials: async () => credentials,
    loadCredentials: () => { throw new Error('Must not consult local keys'); },
    validateCredentials: async (value) => validated.push(value),
    execute: unexpectedLogin,
  });
  assert.deepEqual(await auth.credentials(), credentials);
  assert.deepEqual(validated, [credentials]);
  assert.equal(auth.getStatus().status, 'authenticated');
  assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-test/);
});

it('preserves valid existing AWS credentials and periodically revalidates copied KLAM keys', async () => {
  const copied = { ...credentials };
  delete copied.expiration;
  const before = Date.now();
  const auth = createAwsAuth({
    loadLoginCredentials: missing,
    loadCredentials: async () => copied,
    validateCredentials: async (value) => assert.equal(value, copied),
    execute: unexpectedLogin,
  });
  const result = await auth.credentials();
  assert.equal(result.accessKeyId, copied.accessKeyId);
  assert.ok(result.expiration.getTime() >= before + 15 * 60_000);
  assert.ok(result.expiration.getTime() <= Date.now() + 15 * 60_000);
});

it('opens browser login for expired KLAM credentials and shares concurrent credential requests', async () => {
  const calls = [];
  const notices = [];
  let loggedIn = false;
  let finishLogin;
  const auth = createAwsAuth({
    profile: 'operator-login',
    loadLoginCredentials: async () => (loggedIn ? credentials : missing()),
    loadCredentials: async () => ({ ...credentials, accessKeyId: 'expired-key' }),
    validateCredentials: async (value) => {
      if (value.accessKeyId === 'expired-key') {
        throw Object.assign(new Error('Expired secret must not appear in status'), { name: 'ExpiredToken' });
      }
    },
    execute: async (args) => {
      calls.push(args);
      if (args[0] === '--version') return 'aws-cli/2.32.0 Python/3.13 Darwin/27\n';
      if (args[0] === 'configure') return;
      await new Promise((resolve) => { finishLogin = resolve; });
      loggedIn = true;
    },
    onLogin: (message) => notices.push(message),
  });
  const first = auth.credentials();
  assert.equal(auth.credentials(), first);
  assert.equal(auth.signIn(), first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.getStatus().status, 'signing-in');
  assert.equal(notices.length, 1);
  assert.deepEqual(calls, [
    ['--version'],
    ['configure', 'set', 'region', 'us-east-1', '--profile', 'operator-login'],
    ['login', '--profile', 'operator-login', '--region', 'us-east-1'],
  ]);
  finishLogin();
  assert.deepEqual(await first, credentials);
  assert.deepEqual(await auth.credentials(), credentials);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-test|Expired secret/);
});

it('requires a new browser session when cached login credentials expire', async () => {
  let loggedIn = false;
  let calls = 0;
  const auth = createAwsAuth({
    loadLoginCredentials: async () => (loggedIn ? credentials
      : { ...credentials, expiration: new Date(0) }),
    loadCredentials: missing,
    validateCredentials: async (value) => assert.equal(value, credentials),
    execute: async (args) => {
      calls += 1;
      if (args[0] === '--version') return 'aws-cli/2.40.1';
      if (args[0] === 'login') loggedIn = true;
    },
    onLogin() {},
  });
  assert.deepEqual(await auth.credentials(), credentials);
  assert.equal(calls, 3);
});

it('explicit browser sign-in bypasses ambient credentials and reports old or missing AWS CLI', async () => {
  for (const version of ['aws-cli/2.28.18', 'aws-cli/1.40.0', 'unrecognized', null]) {
    let calls = 0;
    const auth = createAwsAuth({
      loadCredentials: () => { throw new Error('Must bypass ambient credentials'); },
      loadLoginCredentials: async () => credentials,
      validateCredentials: async () => {},
      execute: async (args) => {
        calls += 1;
        assert.deepEqual(args, ['--version']);
        if (version === null) throw Object.assign(new Error('Not installed'), { code: 'ENOENT' });
        return version;
      },
    });
    await assert.rejects(auth.signIn(), /requires AWS CLI 2\.32\.0 or newer/);
    assert.equal(calls, 1);
    assert.equal(auth.getStatus().status, 'failed');
    assert.match(auth.getStatus().error, /Install or upgrade|Upgrade/);
  }
});

it('does not open login for network or authorization errors, and does not expose provider details', async () => {
  for (const name of ['TimeoutError', 'AccessDenied']) {
    const auth = createAwsAuth({
      loadLoginCredentials: missing,
      loadCredentials: async () => credentials,
      validateCredentials: async () => { throw Object.assign(new Error('private-test-secret'), { name }); },
      execute: unexpectedLogin,
    });
    await assert.rejects(auth.credentials(), /Check connectivity and AWS account access/);
    assert.equal(auth.getStatus().status, 'failed');
    assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-test/);
  }
});

it('surfaces browser login failure, permits retry, and keeps validation failures private', async () => {
  let attempts = 0;
  let validationFails = true;
  const auth = createAwsAuth({
    loadLoginCredentials: async () => credentials,
    validateCredentials: async () => {
      if (validationFails) throw new Error('private-test-secret');
    },
    execute: async (args) => {
      if (args[0] === '--version') return 'aws-cli/2.32.0';
      if (args[0] === 'configure') return;
      if (++attempts === 1) throw new Error('AWS browser sign-in failed or timed out');
    },
    onLogin() {},
  });
  await assert.rejects(auth.signIn(), /failed or timed out/);
  await assert.rejects(auth.signIn(), /credentials could not be validated/);
  assert.doesNotMatch(JSON.stringify(auth.getStatus()), /private-test/);
  validationFails = false;
  assert.deepEqual(await auth.signIn(), credentials);
  assert.equal(auth.getStatus().status, 'authenticated');
  assert.equal(auth.getStatus().error, undefined);
});
