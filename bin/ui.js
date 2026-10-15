#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { applyDevVars } from '../src/storage.js';
import { createExperimentalUiServer } from '../src/experimental-ui.js';

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '3000' },
      'env-file': { type: 'string', default: '.dev.vars' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: npm run ui -- [--port 3000] [--env-file .dev.vars]');
  } else {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Port must be an integer from 0 to 65535');
    }
    applyDevVars(await fs.readFile(values['env-file'], 'utf8'));
    const server = createExperimentalUiServer({ envFile: values['env-file'] });
    server.on('error', (error) => {
      console.error(`UI server failed: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Experimental migration UI: http://127.0.0.1:${server.address().port}`);
      console.log('Preparation only; remote writes disabled. Press Ctrl+C to stop.');
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}