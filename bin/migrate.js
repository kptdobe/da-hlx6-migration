#!/usr/bin/env node
import { migrateCli } from '../src/migration-cli.js';

try {
  const report = await migrateCli(process.argv.slice(2));
  if (report?.blockers.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}