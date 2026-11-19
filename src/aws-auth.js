import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fromLoginCredentials, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const execFileAsync = promisify(execFile);
const REVALIDATION_LIFETIME = 15 * 60_000;
const AUTH_ERRORS = new Set([
  'CredentialsProviderError', 'TokenProviderError', 'ExpiredToken', 'ExpiredTokenException',
  'InvalidClientTokenId', 'InvalidAccessKeyId', 'UnrecognizedClientException', 'UnauthorizedException',
]);

async function executeAws(args, { capture = false } = {}) {
  const env = { ...process.env, AWS_PAGER: '' };
  if (capture) {
    const { stdout } = await execFileAsync('aws', args, { encoding: 'utf8', env });
    return stdout;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: 'inherit', env, timeout: 600_000 });
    child.once('error', () => reject(new Error('Could not start AWS browser sign-in. Check the AWS CLI installation.')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('AWS browser sign-in failed or timed out. Check the terminal and ensure the KLAM role has SignInLocalDevelopmentAccess.'));
    });
  });
}

async function validateAwsCredentials(credentials, region) {
  const client = new STSClient({ region, credentials, maxAttempts: 2 });
  try {
    await client.send(new GetCallerIdentityCommand({}));
  } finally {
    client.destroy();
  }
}

export function createAwsAuth({
  profile = 'da-hlx6-migration-login',
  region = 'us-east-1',
  loadCredentials = () => fromNodeProviderChain({ ignoreCache: true })(),
  loadLoginCredentials = () => fromLoginCredentials({ profile, ignoreCache: true })(),
  validateCredentials = (credentials) => validateAwsCredentials(credentials, region),
  execute = executeAws,
  onLogin = (message) => console.error(message),
} = {}) {
  let state = { status: 'unknown', message: 'AWS authentication has not been checked. Sign in or prepare to authenticate.' };
  let pending;
  let useBrowserAuth = false;

  async function checked(load) {
    const credentials = await load();
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
      throw new Error('AWS authentication returned incomplete credentials');
    }
    if (credentials.expiration && credentials.expiration.getTime() <= Date.now()) {
      throw Object.assign(new Error('AWS credentials have expired'), { name: 'ExpiredToken' });
    }
    await validateCredentials(credentials);
    // Copied KLAM credentials often omit expiration; revalidate them periodically.
    return { ...credentials, expiration: credentials.expiration || new Date(Date.now() + REVALIDATION_LIFETIME) };
  }

  async function browserLogin() {
    let version;
    try {
      version = await execute(['--version'], { capture: true });
    } catch (error) {
      throw new Error('AWS browser sign-in requires AWS CLI 2.32.0 or newer. Install or upgrade the AWS CLI, then retry.', { cause: error });
    }
    const match = version.match(/aws-cli\/(\d+)\.(\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 32)) {
      throw new Error('AWS browser sign-in requires AWS CLI 2.32.0 or newer. Upgrade the AWS CLI, then retry.');
    }
    try {
      await execute(['configure', 'set', 'region', region, '--profile', profile]);
    } catch (error) {
      throw new Error('Could not configure the AWS browser-login profile region. Check write permissions on your AWS config file and retry.', { cause: error });
    }
    state = {
      status: 'signing-in',
      message: 'Complete AWS sign-in in the browser. Select your KLAM operator console session; if needed, sign into KLAM first. Check the server terminal if the browser does not open.',
    };
    onLogin(state.message);
    await execute(['login', '--profile', profile, '--region', region]);
    useBrowserAuth = true;
    try {
      return await checked(loadLoginCredentials);
    } catch (error) {
      throw new Error('AWS browser login completed, but its credentials could not be validated. Check the selected KLAM operator session and retry.', { cause: error });
    }
  }

  async function obtainCredentials() {
    const providers = useBrowserAuth ? [loadLoginCredentials] : [loadLoginCredentials, loadCredentials];
    for (const load of providers) {
      try {
        const credentials = await checked(load);
        if (load === loadLoginCredentials) useBrowserAuth = true;
        return credentials;
      } catch (error) {
        if (!AUTH_ERRORS.has(error.name) && !AUTH_ERRORS.has(error.code)) {
          throw new Error('AWS credential validation failed. Check connectivity and AWS account access before retrying.', { cause: error });
        }
      }
    }
    return browserLogin();
  }

  function start(action) {
    if (pending) return pending;
    state = { status: 'signing-in', message: 'Checking AWS authentication; browser sign-in will open if needed.' };
    pending = action().then((credentials) => {
      state = { status: 'authenticated', message: 'AWS authentication completed. Storage permissions are checked when preparing.' };
      return credentials;
    }).catch((error) => {
      state = { status: 'failed', message: 'AWS authentication failed. You can try again.', error: error.message };
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  return {
    credentials: () => start(obtainCredentials),
    signIn: () => start(browserLogin),
    getStatus: () => ({ ...state }),
  };
}
