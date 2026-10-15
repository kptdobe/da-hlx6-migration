import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { getValidToken, clearStoredToken } from 'da-auth-helper';
import { migrateCli } from './migration-cli.js';

const SITE = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
  });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error('Request body exceeds 4096 bytes');
  }
  const input = JSON.parse(body);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['source', 'target', 'fullValidation'].includes(key))
    || typeof input.source !== 'string' || !SITE.test(input.source)
    || (input.target !== undefined && (typeof input.target !== 'string' || !SITE.test(input.target)))
    || (input.fullValidation !== undefined && typeof input.fullValidation !== 'boolean')) {
    throw new Error('Expected source and optional target as org/site, and optional fullValidation boolean');
  }
  return { source: input.source, target: input.target ?? input.source, fullValidation: input.fullValidation === true };
}

export function createExperimentalUiServer({
  envFile = '.dev.vars',
  tokenProvider = ({ browserLogin = false } = {}) => getValidToken({
    override: browserLogin ? undefined : process.env.DA_CONFIG_TOKEN,
  }),
  clearToken = clearStoredToken,
  fetchImpl = fetch,
  runDryRun = migrateCli,
} = {}) {
  let job = null;
  let auth = { status: 'unknown', message: 'DA authentication has not been checked. Sign in or prepare to authenticate.' };
  let useBrowserAuth = false;

  async function authenticate(forceLogin = false) {
    auth = { status: 'signing-in', message: 'Complete DA sign-in in the browser window. If it does not open, use the login URL in the server terminal.' };
    try {
      if (forceLogin) {
        useBrowserAuth = true;
        await clearToken();
      }
      const token = await tokenProvider({ browserLogin: useBrowserAuth });
      if (typeof token !== 'string' || !token.trim()) throw new Error('DA authentication returned no token');
      auth = { status: 'authenticated', message: 'DA sign-in completed. Site permissions are checked when preparing.' };
      return token;
    } catch (error) {
      auth = { status: 'failed', message: 'DA sign-in failed. You can try again.', error: error.message };
      throw error;
    }
  }

  async function prepare(current) {
    const update = (phase) => { current.phase = phase; };
    try {
      update('Authenticating with DA; complete browser sign-in if prompted');
      const token = await authenticate();
      const configs = {};
      for (const site of new Set([current.source, current.target])) {
        update(`Loading aggregated config for ${site}`);
        const [org, name] = site.split('/');
        const url = `https://api.aem.live/${org}/sites/${name}/config.json?aggregated=true`;
        const response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status === 401) {
          auth = { status: 'required', message: 'DA authentication was rejected. Sign in with DA, then prepare again.' };
        }
        if (!response.ok) throw new Error(`Config fetch failed for ${site} (${response.status}); check DA sign-in and config:read permission`);
        const config = await response.json();
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new Error(`Invalid site config for ${site}: expected an object`);
        }
        configs[site] = config;
        current.configs = configs;
      }
      const progress = {
        summary: (message) => update(message),
        log: (message) => update(message),
        onProgress: (event) => {
          update(`${event.phase}${event.total === undefined ? '' : ` (${event.completed ?? 0}/${event.total})`}`);
        },
        async run(phase, action) {
          update(phase);
          return action();
        },
        close() {},
      };
      current.report = await runDryRun([
        '--dry-run', '--env-file', envFile,
        ...(current.fullValidation ? ['--full-validation'] : []),
        current.source, current.target,
      ], { tokenProvider: () => token, fetchImpl, progress });
      if (!current.report || current.report.dryRun !== true) throw new Error('Expected a read-only dry-run report');
      current.status = current.report.blockers.length ? 'blocked' : 'complete';
      update(current.status === 'blocked' ? 'Dry-run has blockers' : 'Preparation complete');
    } catch (error) {
      current.status = 'failed';
      current.error = error.message;
      update('Preparation failed');
    }
  }

  return createServer(async (request, response) => {
    // Reject DNS rebinding and cross-origin browser access to local credentials.
    const authority = `127.0.0.1:${response.socket.localPort}`;
    if (request.headers.host !== authority) {
      send(response, 403, { error: 'Use the printed 127.0.0.1 URL' });
      return;
    }
    if (request.headers.origin && request.headers.origin !== `http://${authority}`) {
      send(response, 403, { error: 'Cross-origin requests are not allowed' });
      return;
    }
    try {
      if (request.method === 'POST'
        && (request.headers.origin !== `http://${authority}`
          || request.headers['content-type'] !== 'application/json')) {
        send(response, 403, { error: 'A same-origin JSON request is required' });
        return;
      }
      if (request.url === '/api/auth' && request.method === 'GET') {
        send(response, 200, auth);
      } else if (request.url === '/api/auth' && request.method === 'POST') {
        if (job?.status === 'running' || auth.status === 'signing-in') {
          send(response, 409, { error: 'Authentication or preparation is already running' });
          return;
        }
        const signingIn = authenticate(true);
        send(response, 202, auth);
        void signingIn.catch((error) => console.error(`DA sign-in failed: ${error.message}`));
      } else if (request.url === '/api/prepare' && request.method === 'GET') {
        send(response, 200, job);
      } else if (request.url === '/api/prepare' && request.method === 'POST') {
        let input;
        try {
          input = await readInput(request);
        } catch (error) {
          send(response, 400, { error: error.message });
          return;
        }
        if (job?.status === 'running' || auth.status === 'signing-in') {
          send(response, 409, { error: 'Authentication or preparation is already running' });
          return;
        }
        job = { ...input, status: 'running', phase: 'Starting preparation', configs: {} };
        send(response, 202, job);
        void prepare(job);
      } else if (request.method === 'GET' && ASSETS.has(request.url)) {
        const [file, type] = ASSETS.get(request.url);
        send(response, 200, await fs.readFile(new URL(`../ui/${file}`, import.meta.url)), type);
      } else {
        send(response, 404, { error: 'Not found' });
      }
    } catch (error) {
      console.error(`UI request failed: ${error.message}`);
      if (!response.headersSent) send(response, 500, { error: 'UI request failed; see the server terminal' });
      else response.destroy();
    }
  });
}