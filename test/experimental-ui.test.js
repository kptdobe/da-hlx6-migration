import { it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExperimentalUiServer } from '../src/experimental-ui.js';
import { migrateCli } from '../src/migration-cli.js';
import { fakeClient } from './fixtures/fake-client.js';

const config = {
  content: { source: { url: 'https://content.da.live/source-org/source-site' } },
  access: { admin: ['test@example.com'] },
  editor: { da: {} },
};

function reportFor(source, target, blockers = []) {
  return { source, target, dryRun: true, validation: 'inventory', blockers, warnings: [] };
}

async function start(t, options = {}) {
  const calls = [];
  const server = createExperimentalUiServer({
    tokenProvider: async () => 'private-test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(config);
    },
    runDryRun: async (args) => reportFor(...args.slice(-2)),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  }));
  const get = (endpoint = '/api/prepare') => fetch(`${origin}${endpoint}`).then((res) => res.json());
  const post = (input, headers = {}, endpoint = '/api/prepare') => fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
  const finished = async (endpoint = '/api/prepare') => {
    for (let i = 0; i < 100; i += 1) {
      const job = await get(endpoint);
      if (!['running', 'signing-in'].includes(job?.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Preparation did not finish');
  };
  return { origin, post, get, finished, calls };
}

it('serves the browser UI and only known static assets with restrictive headers', async (t) => {
  const { origin, get } = await start(t);
  assert.equal(await get(), null);
  for (const [asset, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 0);
  }
  for (const path of ['/.dev.vars', '/src/auth.js', '/missing']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
});

it('authenticates, deduplicates identical sites, and runs only an inventory dry-run', async (t) => {
  let authenticated = false;
  let invocation;
  const { post, finished, calls, get } = await start(t, {
    envFile: '/private/custom.env',
    tokenProvider: async () => { authenticated = true; return 'private-test-token'; },
    runDryRun: async (args, options) => {
      assert.equal(authenticated, true);
      assert.equal(options.tokenProvider(), 'private-test-token');
      invocation = args;
      await options.progress.run('Test stage', async () => {});
      options.progress.onProgress({ phase: 'Listing', completed: 2, total: 3 });
      options.progress.close();
      return reportFor(...args.slice(-2));
    },
  });
  assert.equal((await post({ source: 'source-org/source-site' })).status, 202);
  const job = await finished();
  assert.equal(job.status, 'complete');
  assert.equal(job.target, job.source);
  assert.deepEqual(invocation, ['--dry-run', '--env-file', '/private/custom.env', job.source, job.source]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.aem.live/source-org/sites/source-site/config.json?aggregated=true');
  assert.equal(calls[0].init.headers.authorization, 'Bearer private-test-token');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(job.configs, { [job.source]: config });
  assert.equal(job.report.dryRun, true);
  assert.equal((await get('/api/auth')).status, 'authenticated');
  assert.ok(!JSON.stringify(job).includes('private-test-token'));
});

it('offers explicit asynchronous sign-in without starting preparation and uses the fresh login afterward', async (t) => {
  let cleared = 0;
  let resolveLogin;
  const attempts = [];
  const { post, get, finished, calls } = await start(t, {
    clearToken: async () => { cleared += 1; },
    tokenProvider: (options) => {
      attempts.push(options);
      if (attempts.length === 1) return new Promise((resolve) => { resolveLogin = resolve; });
      return 'fresh-token';
    },
  });
  assert.equal((await get('/api/auth')).status, 'unknown');
  assert.equal((await post({}, {}, '/api/auth')).status, 202);
  assert.equal((await get('/api/auth')).status, 'signing-in');
  assert.equal(await get(), null);
  assert.equal(calls.length, 0);
  assert.equal(cleared, 1);
  assert.equal((await post({}, {}, '/api/auth')).status, 409);
  assert.equal((await post({ source: 'org/site' })).status, 409);
  resolveLogin('fresh-token');
  assert.equal((await finished('/api/auth')).status, 'authenticated');
  await post({ source: 'org/site' });
  assert.equal((await finished()).status, 'complete');
  assert.deepEqual(attempts, [{ browserLogin: true }, { browserLogin: true }]);
  assert.equal(calls[0].init.headers.authorization, 'Bearer fresh-token');
  assert.ok(!JSON.stringify(await get('/api/auth')).includes('fresh-token'));
});

it('allows fresh sign-in and retry after a rejected config authentication', async (t) => {
  let cleared = 0;
  let fetches = 0;
  const { post, get, finished } = await start(t, {
    clearToken: async () => { cleared += 1; },
    tokenProvider: async ({ browserLogin }) => (browserLogin ? 'fresh-token' : 'expired-token'),
    fetchImpl: async () => (++fetches === 1 ? new Response('', { status: 401 }) : Response.json(config)),
    runDryRun: async (args, options) => {
      assert.equal(options.tokenProvider(), 'fresh-token');
      return reportFor(...args.slice(-2));
    },
  });
  await post({ source: 'org/site' });
  assert.equal((await finished()).status, 'failed');
  assert.equal((await get('/api/auth')).status, 'required');
  await post({}, {}, '/api/auth');
  assert.equal((await finished('/api/auth')).status, 'authenticated');
  assert.equal(cleared, 1);
  await post({ source: 'org/site' });
  assert.equal((await finished()).status, 'complete');
});

it('surfaces sign-in errors and permits retry without exposing credentials', async (t) => {
  let tries = 0;
  const { post, finished } = await start(t, {
    clearToken: async () => {},
    tokenProvider: async () => {
      if (++tries === 1) throw new Error('Browser login timed out');
      return 'fresh-token';
    },
  });
  await post({}, {}, '/api/auth');
  const auth = await finished('/api/auth');
  assert.equal(auth.status, 'failed');
  assert.match(auth.error, /Browser login timed out/);
  await post({}, {}, '/api/auth');
  assert.equal((await finished('/api/auth')).status, 'authenticated');
});

it('loads separate source/destination configs and explicitly opts into full validation', async (t) => {
  let invocation;
  const { post, finished, calls } = await start(t, {
    runDryRun: async (args) => {
      invocation = args;
      return { ...reportFor(...args.slice(-2)), validation: 'full' };
    },
  });
  await post({ source: 'source-org/source-site', target: 'target-org/target-site', fullValidation: true });
  const job = await finished();
  assert.equal(job.status, 'complete');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.aem.live/target-org/sites/target-site/config.json?aggregated=true');
  assert.deepEqual(Object.keys(job.configs), [job.source, job.target]);
  assert.ok(invocation.includes('--full-validation'));
  assert.ok(!invocation.includes('--execute'));
  assert.ok(!invocation.includes('--overwrite'));
});

it('rejects invalid inputs and execution-related options without authenticating', async (t) => {
  let authenticated = false;
  const { post } = await start(t, {
    tokenProvider: async () => { authenticated = true; return 'token'; },
  });
  for (const input of [
    {}, null, [], { source: '../secret' }, { source: 'ORG/site' },
    { source: 'org/site', target: 'https://example.com' },
    { source: 'org/site', fullValidation: 'true' },
    { source: 'org/site', execute: true }, { source: 'org/site', overwrite: true },
    { source: `org/${'a'.repeat(5000)}` },
  ]) {
    const response = await post(input);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(authenticated, false);
});

it('rejects foreign origins, hostnames, and non-JSON browser requests', async (t) => {
  const { origin, post } = await start(t);
  const input = { source: 'org/site' };
  for (const headers of [
    { origin: 'https://example.com' },
    { origin: 'null' },
    { origin: '' },
    { 'content-type': 'text/plain' },
  ]) {
    assert.equal((await post(input, headers)).status, 403, JSON.stringify(headers));
    assert.equal((await post({}, headers, '/api/auth')).status, 403, JSON.stringify(headers));
  }
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/prepare`, {
      headers: { host: 'attacker.example' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${origin}/api/prepare`, { headers: { origin: 'https://example.com' } })).status, 403);
});

it('keeps authentication asynchronous, refuses concurrent jobs, and permits a later retry', async (t) => {
  let resolveToken;
  const { post, get, finished } = await start(t, {
    tokenProvider: () => new Promise((resolve) => { resolveToken = resolve; }),
  });
  await post({ source: 'org/site' });
  assert.equal((await get()).status, 'running');
  assert.equal((await post({ source: 'other/site' })).status, 409);
  assert.equal((await post({}, {}, '/api/auth')).status, 409);
  resolveToken('token');
  assert.equal((await finished()).status, 'complete');
  assert.equal((await post({ source: 'other/site' })).status, 202);
  resolveToken('token');
  assert.equal((await finished()).source, 'other/site');
});

it('does not start a second preparation when an earlier request body finishes late', async (t) => {
  let resolveToken;
  let attempts = 0;
  const { origin, post, finished } = await start(t, {
    tokenProvider: () => {
      attempts += 1;
      return new Promise((resolve) => { resolveToken = resolve; });
    },
  });
  let request;
  const firstStatus = new Promise((resolve, reject) => {
    request = httpRequest(`${origin}/api/prepare`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.write('{"source":');
  });
  assert.equal((await post({ source: 'second/site' })).status, 202);
  request.end('"first/site"}');
  assert.equal(await firstStatus, 409);
  assert.equal(attempts, 1);
  resolveToken('token');
  assert.equal((await finished()).source, 'second/site');
});

it('reports authentication failures and never fetches configs without a token', async (t) => {
  for (const tokenProvider of [
    async () => { throw new Error('DA login timed out'); },
    async () => '',
  ]) {
    const { post, finished, calls } = await start(t, { tokenProvider });
    await post({ source: 'org/site' });
    const job = await finished();
    assert.equal(job.status, 'failed');
    assert.match(job.error, /DA login timed out|no token/);
    assert.equal(calls.length, 0);
  }
});

it('preserves source config and exposes destination authorization failures without running inventory', async (t) => {
  let fetches = 0;
  let ran = false;
  const { post, finished } = await start(t, {
    fetchImpl: async () => (++fetches === 1 ? Response.json(config) : new Response('', { status: 403 })),
    runDryRun: async () => { ran = true; },
  });
  await post({ source: 'source/site', target: 'target/site' });
  const job = await finished();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /target\/site \(403\)/);
  assert.deepEqual(job.configs, { 'source/site': config });
  assert.equal(ran, false);
});

it('rejects malformed config responses explicitly', async (t) => {
  for (const value of [null, [], 'not an object']) {
    const { post, finished } = await start(t, { fetchImpl: async () => Response.json(value) });
    await post({ source: 'org/site' });
    const job = await finished();
    assert.equal(job.status, 'failed');
    assert.match(job.error, /Invalid site config/);
  }
});

it('shows blocked reports and preserves configs if the dry-run throws', async (t) => {
  for (const throws of [false, true]) {
    const { post, finished } = await start(t, {
      runDryRun: async (args) => {
        if (throws) throw new Error('AWS credentials unavailable');
        return reportFor(...args.slice(-2), ['Source path collision']);
      },
    });

    await post({ source: 'org/site' });
    const job = await finished();
    assert.deepEqual(job.configs, { 'org/site': config });
    assert.equal(job.status, throws ? 'failed' : 'blocked');
    if (throws) assert.match(job.error, /AWS credentials unavailable/);
    else assert.deepEqual(job.report.blockers, ['Source path collision']);
  }
});

it('persists the actual CLI inventory report without content downloads or writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-ui-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, 'env');
  await fs.writeFile(envFile, '');
  for (const [name, targetEntries, files, emptySource] of [
    ['absent', {}, 0, false],
    ['folders', { 'org/site/.props': { body: '{}' }, 'org/site/nested/': { body: '' } }, 0, false],
    ['files', {
      'org/site/index.html': { body: '' },
      'org/site/.props': { body: '{}' },
      'org/site/.versions/doc/version': { body: 'history' },
    }, 2, false],
    ['source-failure', { 'org/site/index.html': { body: '' } }, 1, true],
  ]) {
    const reportFile = path.join(directory, `${name}.json`);
    const source = fakeClient(emptySource ? {} : { 'org/site/index.html': { body: '<main>Source</main>' } });
    const destination = fakeClient({
      'orgs/org/sites/site.json': { body: JSON.stringify({ content: { contentBusId: 'a'.repeat(59) } }) },
      ...targetEntries,
    });
    const { post, finished } = await start(t, {
      envFile,
      runDryRun: (args, options) => migrateCli([...args, '--out', reportFile], {
        ...options,
        createReadClient: (backend) => (backend === 'da' ? source : destination),
        createWriteClient: () => { throw new Error('Must not construct a write client'); },
      }),
    });
    await post({ source: 'org/site' });
    const job = await finished();
    assert.equal(job.status, emptySource ? 'blocked' : 'complete', name);
    assert.equal(job.report.validation, 'inventory');
    assert.equal(job.report.targetObjects, Object.keys(targetEntries).length, name);
    assert.equal(job.report.targetFiles, files, name);
    if (!emptySource) {
      assert.equal(job.report.sourceObjects, 1);
      assert.equal(job.report.sourceSummary.content.objects, 1);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(reportFile, 'utf8')), job.report);
    assert.ok(source.calls.every((command) => command === 'ListObjectsV2Command'));
    assert.ok(destination.calls.every((command) => ['ListObjectsV2Command', 'GetObjectCommand'].includes(command)));
  }
});