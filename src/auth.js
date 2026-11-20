import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValidToken, clearStoredToken } from 'da-auth-helper';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DA_TOKEN_FILE = path.join(os.homedir(), '.aem', 'da-token.json');
const CLOCK_SKEW = 60_000;

function tokenExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    // Opaque IMS tokens do not necessarily contain JWT expiry metadata.
    return null;
  }
  const expiry = new Date(typeof claims?.exp === 'number' ? claims.exp * 1000 : NaN);
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null;
}

export async function readDaSession({
  token = process.env.DA_CONFIG_TOKEN,
  readFile = fs.readFile,
} = {}) {
  if (token) return { token, expiresAt: tokenExpiry(token), source: 'environment' };
  let text;
  try {
    text = await readFile(DA_TOKEN_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read the saved DA session. Check token-cache file permissions or sign in again.', { cause: error });
  }
  let stored;
  try {
    stored = JSON.parse(text);
  } catch (error) {
    throw new Error('The saved DA session is not valid JSON. Sign in again to replace it.', { cause: error });
  }
  const expiry = new Date(typeof stored?.expires_at === 'number' ? stored.expires_at : NaN);
  if (typeof stored?.access_token !== 'string' || !stored.access_token.trim()
    || (stored.expires_at != null && !Number.isFinite(expiry.getTime()))) {
    throw new Error('The saved DA session has invalid token or expiry metadata. Sign in again to replace it.');
  }
  const expiresAt = Number.isFinite(expiry.getTime())
    ? [expiry.toISOString(), tokenExpiry(stored.access_token)].filter(Boolean).sort()[0] : null;
  return { token: stored.access_token, expiresAt, source: 'cache' };
}

export function createDaAuth({
  tokenProvider = ({ browserLogin = false } = {}) => getValidToken({
    override: browserLogin ? undefined : process.env.DA_CONFIG_TOKEN,
  }),
  clearToken = clearStoredToken,
  cachedTokenProvider = ({ browserLogin = false } = {}) => readDaSession({
    token: browserLogin ? '' : process.env.DA_CONFIG_TOKEN,
  }),
  now = Date.now,
} = {}) {
  let state = { status: 'unknown', message: 'Checking for a saved DA session.' };
  let useBrowserAuth = false;
  let restoring;

  function getStatus() {
    if (state.status === 'authenticated' && state.expiresAt
      && Date.parse(state.expiresAt) <= now() + CLOCK_SKEW) {
      state = { ...state, status: 'required', message: 'The DA token has expired or expires within one minute. Sign in again before starting another run.' };
    }
    return { ...state };
  }

  function connected(expiresAt, message) {
    state = {
      status: 'authenticated', message, expiresAt, refreshable: false,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function restore() {
    if (restoring) return restoring;
    if (state.status !== 'unknown') return getStatus();
    state = { status: 'checking', message: 'Checking the saved DA session without opening sign-in.' };
    restoring = (async () => {
      try {
        const session = await cachedTokenProvider({ browserLogin: useBrowserAuth });
        if (session && (session.expiresAt || session.source === 'environment')) {
          connected(session.expiresAt, 'Saved DA session restored. Site permissions are checked during analysis.');
        } else {
          state = { status: 'required', message: session
            ? 'The saved DA session has no expiry metadata. Sign in again to renew it.'
            : 'No saved DA session found. Sign in with your Adobe account.' };
        }
      } catch (error) {
        state = { status: 'failed', message: 'Could not restore the saved DA session.', error: error.message };
      }
      return getStatus();
    })().finally(() => { restoring = undefined; });
    return restoring;
  }

  async function authenticate(forceLogin = false) {
    state = { status: 'signing-in', message: 'Complete DA sign-in in the browser window if prompted. Check the server terminal if it does not open.' };
    try {
      if (forceLogin) {
        useBrowserAuth = true;
        await clearToken();
      }
      const token = await tokenProvider({ browserLogin: useBrowserAuth });
      if (typeof token !== 'string' || !token.trim()) throw new Error('DA authentication returned no token');
      const session = await cachedTokenProvider({ browserLogin: useBrowserAuth });
      const expiresAt = session?.token === token ? session.expiresAt : tokenExpiry(token);
      if (expiresAt && Date.parse(expiresAt) <= now() + CLOCK_SKEW) {
        throw new Error('The DA token has expired or expires within one minute. Renew it before starting a run.');
      }
      connected(expiresAt, 'DA session connected. Site permissions are checked during analysis.');
      return token;
    } catch (error) {
      state = { status: 'failed', message: 'DA sign-in failed. You can try again.', error: error.message };
      throw error;
    }
  }

  return {
    restore, authenticate, getStatus,
    requireSignIn() {
      state = { ...state, status: 'required', message: 'DA authentication was rejected. Sign in with DA, then run analysis again.' };
    },
  };
}

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
