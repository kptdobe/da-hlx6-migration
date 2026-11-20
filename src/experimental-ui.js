import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { migrateCli } from './migration-cli.js';
import { normalizeIgnoredFolders } from './migration-selection.js';
import { createAwsAuth } from './aws-auth.js';
import { createDaAuth } from './auth.js';

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
    || Object.keys(input).some((key) => !['source', 'target', 'fullValidation', 'ignoredFolders'].includes(key))
    || typeof input.source !== 'string' || !SITE.test(input.source)
    || (input.target !== undefined && (typeof input.target !== 'string' || !SITE.test(input.target)))
    || (input.fullValidation !== undefined && typeof input.fullValidation !== 'boolean')) {
    throw new Error('Expected source and optional target as org/site, and optional fullValidation boolean');
  }
  return {
    source: input.source, target: input.target ?? input.source, fullValidation: input.fullValidation === true,
    ignoredFolders: normalizeIgnoredFolders(input.ignoredFolders),
  };
}

function summarizeAnalysis(report) {
  const summary = {};
  for (const key of [
    'source', 'target', 'dryRun', 'validation', 'startedAt', 'finishedAt',
    'sourceObjects', 'targetObjects', 'targetFiles', 'sourceBytes', 'targetBytes',
    'sourceSummary', 'targetSummary', 'sourceContentBusId', 'targetContentBusId',
    'sourceConfigWarning', 'blockers', 'skippedChecks', 'ignoredFolders',
  ]) {
    if (report[key] !== undefined) summary[key] = report[key];
  }
  // Keep the first pass available without retransmitting its per-object inventories on every poll.
  summary.warnings = report.warnings.map((warning) => typeof warning === 'string' ? warning
    : Object.fromEntries(['id', 'description', 'reason', 'count', 'severity']
      .filter((key) => warning[key] !== undefined).map((key) => [key, warning[key]])));
  return summary;
}

export function createExperimentalUiServer({
  envFile = '.dev.vars',
  tokenProvider,
  clearToken,
  cachedTokenProvider,
  fetchImpl = fetch,
  runDryRun = migrateCli,
  awsAuth = createAwsAuth(),
  now = Date.now,
} = {}) {
  let job = null;
  const daAuth = createDaAuth({ tokenProvider, clearToken, cachedTokenProvider, now });

  async function prepare(current) {
    const update = (phase, counters = {}) => {
      current.phase = phase;
      current.progress = { phase, ...counters };
      current.updatedAt = new Date().toISOString();
    };
    try {
      update('Authenticating with DA; complete browser sign-in if prompted');
      const token = await daAuth.authenticate();
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
          daAuth.requireSignIn();
        }
        if (response.status === 404) {
          if (site === current.target) {
            throw new Error(`Target site configuration for ${site} does not exist (404). Create the target site configuration manually before migration can proceed, then run analysis again. This tool does not create site configurations.`);
          }
          throw new Error(`Source site configuration for ${site} does not exist (404). Check the source organization and site / repository name, then run analysis again.`);
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
          const counters = {};
          for (const key of ['completed', 'total', 'bytes', 'shardsCompleted', 'shardsTotal', 'pages']) {
            if (Number.isFinite(event[key]) && event[key] >= 0) counters[key] = event[key];
          }
          update(event.phase ?? event.status ?? 'Working', counters);
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
        ...current.ignoredFolders.flatMap((folder) => ['--ignore-folder', folder]),
        current.source, current.target,
      ], { tokenProvider: () => token, fetchImpl, progress, awsAuth });
      if (!current.report || current.report.dryRun !== true) throw new Error('Expected a read-only dry-run report');
      current.status = current.report.blockers.length ? 'blocked' : 'complete';
      update(current.status === 'blocked' ? 'Dry-run has blockers' : 'Preparation complete');
    } catch (error) {
      current.status = 'failed';
      current.error = error.message;
      update('Preparation failed');
    } finally {
      current.finishedAt = new Date().toISOString();
    }
  }

  const busy = () => job?.status === 'running'
    || ['signing-in', 'checking'].includes(daAuth.getStatus().status)
    || ['signing-in', 'checking'].includes(awsAuth.getStatus().status);

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
      if (request.url === '/api/aws-auth' && request.method === 'GET') {
        send(response, 200, await awsAuth.restore());
      } else if (request.url === '/api/aws-auth' && request.method === 'POST') {
        if (busy()) {
          send(response, 409, { error: 'Authentication or preparation is already running' });
          return;
        }
        const signingIn = awsAuth.signIn();
        send(response, 202, awsAuth.getStatus());
        void signingIn.catch((error) => console.error(`AWS sign-in failed: ${error.message}`));
      } else if (request.url === '/api/auth' && request.method === 'GET') {
        send(response, 200, await daAuth.restore());
      } else if (request.url === '/api/auth' && request.method === 'POST') {
        if (busy()) {
          send(response, 409, { error: 'Authentication or preparation is already running' });
          return;
        }
        const signingIn = daAuth.authenticate(true);
        send(response, 202, daAuth.getStatus());
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
        if (busy()) {
          send(response, 409, { error: 'Authentication or preparation is already running' });
          return;
        }
        const sameSelection = job && input.source === job.source && input.target === job.target
          && JSON.stringify(input.ignoredFolders.toSorted()) === JSON.stringify(job.ignoredFolders.toSorted());
        const analysisReport = input.fullValidation && sameSelection
          ? (job.fullValidation ? job.analysisReport : job.report && summarizeAnalysis(job.report)) : undefined;
        const startedAt = new Date().toISOString();
        job = {
          ...input, status: 'running', phase: 'Starting preparation', configs: {},
          startedAt, updatedAt: startedAt,
          ...(analysisReport && { analysisReport }),
        };
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