import fs from 'node:fs';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import {
  S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { assertWritable, sessionTags, sessionName } from './scope.js';

export const BACKENDS = {
  da: { bucket: 'aem-content' },
  hlx6: { bucket: 'helix-source-bus', region: 'us-east-1' },
};

/**
 * Writes an object after checking it is inside the migration scope.
 * @param {object} params PutObject input (Bucket, Key, Body, ContentType, ...)
 */
export async function putObject(client, scope, params) {
  assertWritable(scope, params.Bucket, params.Key);
  return client.send(new PutObjectCommand(params));
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
      maxAttempts: 5,
      requestHandler: httpHandler(),
    });
  }
  if (backend === 'hlx6') {
    return new S3Client({
      region: opts.region || BACKENDS.hlx6.region,
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
export async function listAll(client, bucket, prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken,
    }));
    (resp.Contents || []).forEach((o) => objects.push({
      key: o.Key,
      size: o.Size,
      etag: o.ETag,
      lastModified: new Date(o.LastModified).toISOString(),
    }));
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
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
  return headers(await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
}

/**
 * Gets an object; gzip-encoded bodies (hlx6 convention) are returned decompressed.
 * @returns {Promise<{body: Buffer} & ReturnType<typeof headers>>}
 */
export async function getObject(client, bucket, key) {
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  let body = Buffer.from(await resp.Body.transformToByteArray());
  if (resp.ContentEncoding === 'gzip') body = gunzipSync(body);
  return { ...headers(resp), body };
}
