import { isDeepStrictEqual } from 'node:util';
import { rewriteDaBody } from './da-urls.js';

/**
 * Removes DA sheet wrappers and top-level metadata without changing row data.
 * @param {object} config DA editor configuration.
 * @returns {object} Sheet names mapped to their row arrays.
 */
function sheetRows(config) {
  return Object.fromEntries(Object.entries(config)
    .filter(([key]) => !key.startsWith(':'))
    .map(([key, sheet]) => [key, Array.isArray(sheet) ? sheet : sheet?.data]));
}

/**
 * Migrates site editor settings and same-site DA URLs without replacing unrelated target settings.
 * @param {object} options Scope, execution flag, tokens, fetch and progress callbacks.
 * @returns {Promise<object>} Config status, URLs, planned rewrites and unsupported-URL warnings.
 * @throws {Error} On invalid configuration, authorization errors or unrelated target conflicts.
 */
export async function migrateProjectConfig({
  scope,
  execute = false,
  daConfigToken,
  configToken,
  fetchImpl = fetch,
  onProgress = () => {},
}) {
  const sourceUrl = `https://admin.da.live/config/${scope.daOrg || scope.org}/${scope.daSite}`;
  const targetUrl = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}/config.json`;
  onProgress({ phase: `Reading DA project config ${sourceUrl}` });
  const sourceResponse = await fetchImpl(sourceUrl, {
    headers: daConfigToken ? { authorization: `Bearer ${daConfigToken}` } : {},
  });
  if (sourceResponse.status === 404) return { status: 'absent', sourceUrl, targetUrl };
  if (!sourceResponse.ok) {
    throw new Error(`DA config fetch failed (${sourceResponse.status}): ${sourceUrl}`);
  }
  const sourceConfig = await sourceResponse.json();
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) {
    throw new Error(`Invalid DA project config: ${sourceUrl}`);
  }
  const sourceRows = sheetRows(sourceConfig);
  for (const [name, rows] of Object.entries(sourceRows)) {
    if (!Array.isArray(rows)) {
      throw new Error(`Invalid DA config sheet "${name}": expected a data array`);
    }
  }
  const rewritten = rewriteDaBody({
    body: Buffer.from(JSON.stringify(sourceRows)), contentType: 'application/json', key: sourceUrl,
  }, scope);
  const daConfig = JSON.parse(rewritten.body.toString('utf8'));
  const details = {
    ...(rewritten.rewrites.length && { urlRewrites: rewritten.rewrites }),
    ...(rewritten.unsupported.length && {
      warnings: [{
        id: 'unrewritten-da-config-urls', severity: 'warning',
        description: 'Same-site DA admin config references without a URL-only API mapping were retained',
        count: rewritten.unsupported.length, items: rewritten.unsupported,
      }],
    }),
  };
  if (!configToken) throw new Error('An API token is required to migrate project config');
  const headers = { authorization: `Bearer ${configToken}` };
  onProgress({ phase: `Reading target project config ${targetUrl}` });
  const targetResponse = await fetchImpl(targetUrl, { headers });
  if (!targetResponse.ok) {
    throw new Error(`Target config fetch failed (${targetResponse.status}): ${targetUrl}`);
  }
  const targetConfig = await targetResponse.json();
  if (!targetConfig || typeof targetConfig !== 'object' || Array.isArray(targetConfig)) {
    throw new Error(`Invalid target project config: ${targetUrl}`);
  }
  if (Object.hasOwn(targetConfig.editor || {}, 'da')) {
    const existingConfig = targetConfig.editor.da;
    if (isDeepStrictEqual(existingConfig, daConfig)) {
      return { status: 'exists', sourceUrl, targetUrl, ...details };
    }
    if (!existingConfig || typeof existingConfig !== 'object' || Array.isArray(existingConfig)) {
      throw new Error(`Target editor.da already exists with different config: ${targetUrl}`);
    }
    const existingRows = rewriteDaBody({
      body: Buffer.from(JSON.stringify(sheetRows(existingConfig))), contentType: 'application/json', key: targetUrl,
    }, scope);
    if (!isDeepStrictEqual(JSON.parse(existingRows.body.toString('utf8')), daConfig)) {
      throw new Error(`Target editor.da already exists with different config: ${targetUrl}`);
    }
  }
  if (!execute) return { status: 'planned', sourceUrl, targetUrl, ...details };
  onProgress({ phase: `Writing target editor.da config ${targetUrl}` });
  const response = await fetchImpl(targetUrl.replace('/config.json', '/config/editor/da.json'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(daConfig),
  });
  if (!response.ok) {
    throw new Error(`Target config update failed (${response.status}): ${targetUrl}`);
  }
  return { status: 'written', sourceUrl, targetUrl, ...details };
}