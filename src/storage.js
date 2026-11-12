import fs from 'node:fs';
import https from 'node:https';
import { STATUS_CODES } from 'node:http';
import { gunzipSync } from 'node:zlib';
import {
  S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import processQueue from '@adobe/helix-shared-process-queue';
import { assertWritable, sessionTags, sessionName } from './scope.js';
import { generateShardPrefixes } from './sharding.js';

export const BACKENDS = {
  da: { bucket: 'aem-content' },
  hlx6: { bucket: 'helix-source-bus', region: 'us-east-1' },
};

async function storageRequest(client, command, read = (response) => response) {
  let response;
  try {
    response = await client.send(command);
    return await read(response);
  } catch (error) {
    const operation = command.constructor.name.replace(/Command$/, '');
    const { Bucket: bucket, Key: key, Prefix: prefix } = command.input;
    const metadata = error.$metadata || error.cause?.$metadata || response?.$metadata || {};
    const responseHeaders = error.$response?.headers || {};
    const serviceCode = error.Code || error.code
      || (error.name === 'Error' && error.cause?.name) || error.name || 'UnknownError';
    const details = Object.fromEntries(Object.entries({
      operation, bucket, key, prefix, serviceCode,
      httpStatusCode: metadata.httpStatusCode ?? error.$response?.statusCode,
      attempts: metadata.attempts,
      requestId: metadata.requestId || responseHeaders['x-amz-request-id'],
      extendedRequestId: metadata.extendedRequestId,
      cfRay: responseHeaders['cf-ray'],
      causeCode: error.cause?.code,
    }).filter(([, value]) => value !== undefined));
    const status = details.httpStatusCode;
    const context = [
      serviceCode,
      status ? `HTTP ${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ''}` : 'HTTP status unavailable',
      ...['attempts', 'requestId', 'extendedRequestId', 'cfRay', 'causeCode']
        .filter((field) => details[field] !== undefined)
        .map((field) => `${field}=${JSON.stringify(details[field])}`),
    ];
    if (error.message && error.message !== serviceCode) context.push(error.message);
    if (status === 404 && ['HeadObject', 'GetObject'].includes(operation)) {
      context.push('Object not found; it may have been deleted after listing. Refresh the source inventory');
    } else if (status === 401 || status === 403) {
      context.push('Check storage credentials and bucket/object permissions');
    } else if (status === 429 || status >= 500) {
      context.push('Storage throttling or service failure');
    }
    const failure = new Error(
      `${operation} failed for ${JSON.stringify(`s3://${bucket}/${key ?? prefix ?? ''}`)}: ${context.join('; ')}`,
      { cause: error },
    );
    failure.name = error.name || 'Error';
    if (error.code !== undefined) failure.code = error.code;
    if (error.Code !== undefined) failure.Code = error.Code;
    failure.$metadata = { ...metadata, httpStatusCode: details.httpStatusCode };
    failure.storageError = details;
    throw failure;
  }
}

/**
 * Writes an object after checking it is inside the migration scope.
 * @param {object} params PutObject input (Bucket, Key, Body, ContentType, ...)
 */
export async function putObject(client, scope, params) {
  assertWritable(scope, params.Bucket, params.Key);
  return storageRequest(client, new PutObjectCommand(params));
}

/**
 * S3 client running as the shared migration role, restricted to one migration by session tags.
 * Credentials are refreshed automatically (role chaining caps sessions at 1h).
 * @param {object} scope from createScope
 * @param {string} roleArn migration role ARN
 */
export function createMigrationClient(scope, roleArn, region = BACKENDS.hlx6.region) {
  return new S3Client({
    region,
    maxAttempts: 5,
    requestHandler: httpHandler(),
    credentials: fromTemporaryCredentials({
      masterCredentials: fromNodeProviderChain({ ignoreCache: true }),
      params: {
        RoleArn: roleArn,
        RoleSessionName: sessionName(scope),
        Tags: sessionTags(scope),
        DurationSeconds: 3600,
      },
      clientConfig: { region },
    }),
  });
}

/**
 * Parses a wrangler-style `.dev.vars` file content (KEY=VALUE lines).
 * @param {string} content
 * @returns {Record<string,string>}
 */
export function parseDevVars(content) {
  const vars = {};
  content.split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx <= 0) return;
    let value = line.slice(idx + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    vars[line.slice(0, idx).trim()] = value;
  });
  return vars;
}

export function applyDevVars(content, target = process.env) {
  const vars = parseDevVars(content);
  Object.entries(vars).forEach(([key, value]) => {
    if (value !== '') target[key] = value;
  });
  if (vars.AWS_PROFILE && !(vars.AWS_ACCESS_KEY_ID && vars.AWS_SECRET_ACCESS_KEY)) {
    delete target.AWS_ACCESS_KEY_ID;
    delete target.AWS_SECRET_ACCESS_KEY;
    delete target.AWS_SESSION_TOKEN;
  } else if (vars.AWS_ACCESS_KEY_ID && vars.AWS_SECRET_ACCESS_KEY) {
    delete target.AWS_PROFILE;
  }
  return vars;
}

function httpHandler() {
  return new NodeHttpHandler({
    httpsAgent: new https.Agent({ maxSockets: 200, keepAlive: true }),
  });
}

/**
 * Creates an S3 client for a backend.
 * da: R2 credentials from `.dev.vars` (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_DEF_URL).
 * hlx6: default AWS credential chain (~/.aws/credentials, env, SSO).
 * @param {'da'|'hlx6'} backend
 * @param {object} [opts]
 * @param {string} [opts.devVarsPath] path to `.dev.vars` for R2 credentials
 * @param {string} [opts.region] AWS region for hlx6
 */
export function createClient(backend, opts = {}) {
  if (backend === 'da') {
    const path = opts.devVarsPath || '.dev.vars';
    if (!fs.existsSync(path)) {
      throw new Error(`R2 credentials not found: ${path} (use --env-file)`);
    }
    const env = parseDevVars(fs.readFileSync(path, 'utf8'));
    return new S3Client({
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      endpoint: env.S3_DEF_URL,
      forcePathStyle: true,
      region: 'auto',
      retryMode: opts.retryMode || 'standard',
      maxAttempts: 5,
      requestHandler: httpHandler(),
    });
  }
  if (backend === 'hlx6') {
    return new S3Client({
      credentials: fromNodeProviderChain({ ignoreCache: true }),
      region: opts.region || BACKENDS.hlx6.region,
      retryMode: opts.retryMode || 'standard',
      maxAttempts: 5,
      requestHandler: httpHandler(),
    });
  }
  throw new Error(`Unknown backend: ${backend}`);
}

/**
 * Lists all objects under a prefix, following continuation tokens.
 * @returns {Promise<{key:string,size:number,etag:string,lastModified:string}[]>}
 */
export async function listAll(client, bucket, prefix, { onProgress = () => {} } = {}) {
  const objects = [];
  let pages = 0;
  onProgress({ phase: `Listing s3://${bucket}/${prefix}`, completed: 0 });
  let ContinuationToken;
  do {
    const resp = await storageRequest(client, new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken,
    }));
    (resp.Contents || []).forEach((o) => objects.push({
      key: o.Key,
      size: o.Size,
      etag: o.ETag,
      lastModified: new Date(o.LastModified).toISOString(),
    }));
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    pages += 1;
    onProgress({
      phase: `Listing s3://${bucket}/${prefix} (page ${pages})`,
      completed: objects.length,
      ...(!ContinuationToken && { total: objects.length }),
    });
  } while (ContinuationToken);
  return objects;
}

export async function listSharded(client, bucket, prefix, {
  concurrency = 8, onProgress = () => {}, expandPaths = ['.da-versions/'],
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Listing concurrency must be an integer from 1 to 32');
  }
  const compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
  const boundaries = [...new Set(generateShardPrefixes(prefix, concurrency, { expandPaths })
    .map((shard) => shard.prefix))].sort(compare);
  const ranges = [...boundaries, undefined].map((upper, index) => ({
    lower: index ? boundaries[index - 1] : undefined, upper,
  }));
  const shardsTotal = ranges.length;
  let completed = 0;
  let shardsCompleted = 0;
  let pages = 0;
  const phase = `Listing shards s3://${bucket}/${prefix} (${concurrency} workers)`;
  const progress = (finished = false) => onProgress({
    phase, completed, shardsCompleted, shardsTotal, pages,
    ...(finished && { total: completed }),
  });
  progress();
  const results = await processQueue(ranges, async ({ lower, upper }) => {
    const objects = [];
    let ContinuationToken;
    let finished;
    do {
      const response = await storageRequest(client, new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix,
        ...(lower && { StartAfter: lower }),
        ...(ContinuationToken && { ContinuationToken }),
      }));
      const contents = response.Contents || [];
      for (const object of contents) {
        if (upper && compare(object.Key, upper) > 0) break;
        objects.push({
          key: object.Key, size: object.Size, etag: object.ETag,
          lastModified: new Date(object.LastModified).toISOString(),
        });
        completed += 1;
      }
      pages += 1;
      finished = !response.IsTruncated
        || Boolean(upper && contents.length && compare(contents.at(-1).Key, upper) >= 0);
      ContinuationToken = response.NextContinuationToken;
      if (!finished && !ContinuationToken) throw new Error('Truncated shard listing has no continuation token');
      progress();
    } while (!finished);
    shardsCompleted += 1;
    progress();
    return objects;
  }, concurrency);
  progress(true);
  return results.flat().sort((left, right) => compare(left.key, right.key));
}

function headers(resp) {
  return {
    contentType: resp.ContentType,
    contentEncoding: resp.ContentEncoding,
    contentLength: resp.ContentLength,
    etag: resp.ETag,
    lastModified: resp.LastModified ? new Date(resp.LastModified).toISOString() : undefined,
    metadata: resp.Metadata || {},
  };
}

export async function headObject(client, bucket, key) {
  return headers(await storageRequest(client, new HeadObjectCommand({ Bucket: bucket, Key: key })));
}

/**
 * Gets an object; gzip-encoded bodies (hlx6 convention) are returned decompressed.
 * @returns {Promise<{body: Buffer} & ReturnType<typeof headers>>}
 */
export async function getObject(client, bucket, key) {
  return storageRequest(client, new GetObjectCommand({ Bucket: bucket, Key: key }), async (resp) => {
    let body = Buffer.from(await resp.Body.transformToByteArray());
    if (resp.ContentEncoding === 'gzip') body = gunzipSync(body);
    return { ...headers(resp), body };
  });
}
