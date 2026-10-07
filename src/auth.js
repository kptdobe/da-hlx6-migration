import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Gets the DA bearer token, preferring an explicitly supplied token and otherwise
 * invoking the project's pinned da-auth-helper dependency.
 * @param {{token?: string, execute?: Function}} options
 * @returns {string}
 */
export function getDaAuthToken({ token = process.env.DA_CONFIG_TOKEN, execute = execFileSync } = {}) {
  if (token) return token;
  return execute(
    'npx',
    ['--no-install', 'da-auth-helper', 'token'],
    { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  ).trim();
}
