import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, formatMigrationSummary } from '../src/progress.js';

it('formats the final execution summary with exact write counts and a local snapshot path', () => {
  const statuses = Array.from({ length: 29 }, (_, index) => ({ key: `file-${index}`, status: index < 27 ? 'overwrite' : 'planned' }));
  const summary = formatMigrationSummary({
    dryRun: false, startedAt: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:15.000Z',
    statuses, results: statuses.map(({ key }) => ({ key, status: 'written' })),
    uploadedImageUrls: Array.from({ length: 11 }, (_, index) => `image-${index}`),
    imageErrors: [], projectConfig: { status: 'exists' }, warnings: [], blockers: [],
    sourceObjects: 39, sourceSnapshotComplete: true, sourceDump: '/repo/tmp/xwz',
  }, '/repo');
  assert.equal(summary, [
    'Migration succeeded in **15 seconds**.', '',
    '- **29 objects written:** 27 overwritten, 2 newly created.',
    '- **11 images uploaded**, no image errors.',
    '- Project config already matched; no warnings or blockers.',
    '- All **39 source objects** retained locally: `./tmp/xwz`.',
  ].join('\n'));
});

it('formats blocked and partial execution without claiming success', () => {
  const summary = formatMigrationSummary({
    dryRun: false, startedAt: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:03.000Z',
    statuses: [{ key: 'existing', status: 'overwrite' }], results: [{ key: 'existing', status: 'written' }],
    uploadedImageUrls: ['image'], imageErrors: [{ url: 'failed' }],
    projectConfig: { status: 'planned' }, warnings: [{ count: 1 }], blockers: ['Storage unavailable'],
    sourceSnapshotComplete: false, sourceDump: '/repo/tmp/partial',
  }, '/repo');
  assert.match(summary, /Migration blocked after \*\*3 seconds\*\*/);
  assert.match(summary, /1 object written/);
  assert.match(summary, /1 image uploaded/);
  assert.match(summary, /original URLs retained/);
  assert.match(summary, /Storage unavailable/);
  assert.match(summary, /Partial source snapshot.*\.\/tmp\/partial/);
  assert.doesNotMatch(summary, /Migration succeeded/);
});

it('formats listing-only dry-run results without claiming writes or uploads', () => {
  const summary = formatMigrationSummary({
    dryRun: true, validation: 'inventory',
    startedAt: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:02.000Z',
    sourceObjects: 10, sourceBytes: 1234, targetObjects: 0, targetBytes: 0,
    warnings: [], blockers: [],
  });
  assert.match(summary, /Dry-run completed in \*\*2 seconds\*\*/);
  assert.match(summary, /10 source objects.*1,234 stored bytes/);
  assert.match(summary, /0 target objects/);
  assert.match(summary, /No content writes or image uploads/);
  assert.doesNotMatch(summary, /Migration succeeded|objects written/);
});

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
