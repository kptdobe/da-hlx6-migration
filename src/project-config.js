import { isDeepStrictEqual } from 'node:util';

function sheetRows(config) {
  return Object.fromEntries(Object.entries(config)
    .filter(([key]) => !key.startsWith(':'))
    .map(([key, sheet]) => [key, Array.isArray(sheet) ? sheet : sheet?.data]));
}

export async function migrateProjectConfig({
  scope,
  execute = false,
  daConfigToken,
  configToken,
  fetchImpl = fetch,
}) {
  const sourceUrl = `https://admin.da.live/config/${scope.org}/${scope.daSite}`;
  const targetUrl = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}/config.json`;
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
  const daConfig = sheetRows(sourceConfig);
  for (const [name, rows] of Object.entries(daConfig)) {
    if (!Array.isArray(rows)) {
      throw new Error(`Invalid DA config sheet "${name}": expected a data array`);
    }
  }
  if (!configToken) throw new Error('An API token is required to migrate project config');
  const headers = { authorization: `Bearer ${configToken}` };
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
      return { status: 'exists', sourceUrl, targetUrl };
    }
    if (!existingConfig || typeof existingConfig !== 'object' || Array.isArray(existingConfig)
      || !isDeepStrictEqual(sheetRows(existingConfig), daConfig)) {
      throw new Error(`Target editor.da already exists with different config: ${targetUrl}`);
    }
  }
  if (!execute) return { status: 'planned', sourceUrl, targetUrl };
  const response = await fetchImpl(targetUrl.replace('/config.json', '/config/editor/da.json'), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(daConfig),
  });
  if (!response.ok) {
    throw new Error(`Target config update failed (${response.status}): ${targetUrl}`);
  }
  return { status: 'written', sourceUrl, targetUrl };
}