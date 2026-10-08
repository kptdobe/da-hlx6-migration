import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from '../src/progress.js';

it('prints scope summaries, throttles item output, and always prints completion', () => {
  const lines = [];
  let time = 0;
  const progress = createProgress({ output: (line) => lines.push(line), now: () => time });
  try {
    progress.summary('DRY RUN', { org: 'source-org', repo: 'source' }, {
      org: 'target-org', repo: 'target', contentBusId: 'bus-id',
    });
    assert.match(lines[1], /Source: org=source-org; repo=source; contentBusId=unknown/);
    assert.match(lines[2], /Target: org=target-org; repo=target; contentBusId=bus-id/);
    progress.onProgress({ phase: 'Downloading', completed: 0, total: 100 });
    progress.onProgress({ phase: 'Downloading', completed: 1, total: 100 });
    assert.equal(lines.length, 4);
    time = 5000;
    progress.onProgress({ phase: 'Downloading', completed: 50, total: 100, bytes: 123, key: 'org/site/doc' });
    assert.match(lines.at(-1), /Downloading: 50\/100; 123 bytes; org\/site\/doc/);
    progress.onProgress({ phase: 'Downloading', completed: 100, total: 100 });
    assert.match(lines.at(-1), /Downloading: 100\/100/);
  } finally {
    progress.close();
  }
});

it('prints heartbeats for pending operations and stops them on close', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const lines = [];
  const progress = createProgress({ output: (line) => lines.push(line) });
  progress.log('Reading target config');
  context.mock.timers.tick(15000);
  assert.match(lines.at(-1), /Still working: Reading target config/);
  progress.close();
  const count = lines.length;
  context.mock.timers.tick(30000);
  assert.equal(lines.length, count);
});

it('throttles interleaved progress from concurrent dump reads', () => {
  const lines = [];
  const progress = createProgress({ output: (line) => lines.push(line), now: () => 0 });
  try {
    for (let completed = 0; completed <= 10; completed += 1) {
      for (const phase of ['Source dump', 'Target dump']) {
        progress.onProgress({ phase, completed, total: 10 });
      }
    }
    assert.equal(lines.length, 4);
    assert.match(lines[2], /Source dump: 10\/10/);
    assert.match(lines[3], /Target dump: 10\/10/);
  } finally {
    progress.close();
  }
});

it('reports stage success and failures without swallowing errors', async () => {
  const lines = [];
  const progress = createProgress({ output: (line) => lines.push(line) });
  try {
    assert.equal(await progress.run('Plan', () => 42), 42);
    assert.match(lines[0], /Plan: starting/);
    assert.match(lines[1], /Plan: done/);
    const error = new Error('denied');
    await assert.rejects(progress.run('Read', () => { throw error; }), (result) => result === error);
    assert.match(lines.at(-1), /Read: FAILED \(denied\)/);
  } finally {
    progress.close();
  }
});
