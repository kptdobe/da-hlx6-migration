const READ_COMMANDS = new Set(['ListObjectsV2Command', 'HeadObjectCommand', 'GetObjectCommand']);

export function readOnlyClient(client) {
  return Object.freeze({
    async send(command) {
      if (!READ_COMMANDS.has(command.constructor.name)) {
        throw new Error(`Read-only migration refused ${command.constructor.name}`);
      }
      return client.send(command);
    },
  });
}

export function readOnlyFetch(fetchImpl = fetch) {
  return async (url, options = {}) => {
    if (!['GET', 'HEAD'].includes(options.method || 'GET')) {
      throw new Error(`Read-only migration refused ${options.method}`);
    }
    return fetchImpl(url, { ...options, redirect: 'error' });
  };
}