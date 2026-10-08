#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readDump } from '../src/dump.js';
import { compareDumps } from '../src/compare.js';
import { createProgress } from '../src/progress.js';

const USAGE = `Usage: node bin/compare.js [-o report.json] <da-dump-dir> <hlx6-dump-dir>

Structural comparison of two dumps produced by bin/dump.js.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 2) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const progress = createProgress();
progress.summary('COMPARE; local dumps; no remote access',
  { location: positionals[0], backend: 'da dump' },
  { location: positionals[1], backend: 'hlx6 dump' });
const [da, hlx6] = await Promise.all(positionals.map((dir) => readDump(dir, {
  onProgress: progress.onProgress,
})));
const report = await progress.run(`Comparing ${da.length} DA and ${hlx6.length} HLX6 objects`, () => compareDumps(da, hlx6));

console.log('\n## Object counts by kind');
console.table(Object.fromEntries([...new Set([...Object.keys(report.counts.da), ...Object.keys(report.counts.hlx6)])]
  .map((k) => [k, { da: report.counts.da[k] || 0, hlx6: report.counts.hlx6[k] || 0 }])));

console.log('\n## Current content');
console.table(report.current.matched.map((m) => ({
  kind: m.kind,
  da: m.daPath,
  hlx6: m.hlx6Path,
  sizeDa: m.size.da,
  sizeHlx6: m.size.hlx6,
  uncompressed: m.size.hlx6Uncompressed,
  body: m.body.compared ? (m.body.equal && 'equal') || (m.body.equalNormalized && 'equal (normalized)') || 'DIFFERENT' : '-',
})));
if (report.current.onlyDa.length) {
  console.log('Only in da:');
  console.table(report.current.onlyDa);
}
if (report.current.onlyHlx6.length) {
  console.log('Only in hlx6:');
  console.table(report.current.onlyHlx6);
}
report.current.matched.filter((m) => m.body.diff).forEach((m) => {
  console.log(`\nBody diff ${m.daPath} at offset ${m.body.diff.offset}`);
  console.log(`  da  : ${m.body.diff.da}`);
  console.log(`  hlx6: ${m.body.diff.hlx6}`);
});

console.log('\n## Metadata keys by kind');
['da', 'hlx6'].forEach((b) => {
  console.log(`\n### ${b}`);
  Object.entries(report.metadata[b]).forEach(([kind, s]) => {
    console.log(`- ${kind}: keys=[${s.keys.join(', ')}] encoding=[${s.contentEncodings.join(', ')}]`);
  });
});

console.log('\n## Versions per document');
['da', 'hlx6'].forEach((b) => {
  console.log(`\n### ${b}`);
  console.table(Object.fromEntries(Object.entries(report.versions[b])
    .map(([p, v]) => [p, { count: v.count, labels: v.labels.join(' | ') }])));
});
console.log('\n## da audit lines per doc id');
console.table(report.audit.da);
console.log('\n## Trash');
['da', 'hlx6'].forEach((b) => {
  console.log(`\n### ${b}`);
  console.table(report.trash[b]);
});

if (values.out) {
  progress.log(`Writing report: ${values.out}`);
  await fs.writeFile(values.out, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${values.out}`);
}
progress.log('Comparison complete');
progress.close();
