import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDa, classifyHlx6 } from '../src/classify.js';
import {
  compareDumps, compareBodies, versionsByDoc, auditByDoc,
} from '../src/compare.js';

const entry = (classify, rel, { body, metadata = {}, ...rest } = {}) => ({
  rel,
  ...classify(rel),
  metadata,
  size: body ? Buffer.byteLength(body) : 0,
  ...(body !== undefined && { body: Buffer.from(body) }),
  ...rest,
});
const da = (rel, opts) => entry(classifyDa, rel, opts);
const hx = (rel, opts) => entry(classifyHlx6, rel, opts);

describe('compareBodies', () => {
  it('reports byte-equal bodies', () => {
    assert.deepEqual(compareBodies('doc', Buffer.from('<main/>'), Buffer.from('<main/>')), { compared: true, equal: true });
  });
  it('reports HTML equal after whitespace normalization', () => {
    const res = compareBodies('doc', Buffer.from('<main>\n  <p>a</p>\n</main>'), Buffer.from('<main><p>a</p></main>'));
    assert.equal(res.equal, false);
    assert.equal(res.equalNormalized, true);
  });
  it('locates the first difference in HTML', () => {
    const res = compareBodies('doc', Buffer.from('<main><img src="https://content.da.live/a.png"></main>'), Buffer.from('<main><img src="./media_123.png"></main>'));
    assert.equal(res.equalNormalized, false);
    assert.equal(res.diff.offset, 16);
    assert.match(res.diff.da, /content\.da\.live/);
    assert.match(res.diff.hlx6, /media_123/);
  });
  it('treats re-serialized identical JSON as equal', () => {
    const res = compareBodies('sheet', Buffer.from('{"a": 1}'), Buffer.from('{"a":1}'));
    assert.equal(res.equalNormalized, true);
  });
  it('reports sizes for different binaries', () => {
    assert.deepEqual(compareBodies('media', Buffer.from('ab'), Buffer.from('abc')), {
      compared: true, equal: false, sizeDa: 2, sizeHlx6: 3,
    });
  });
  it('skips the comparison when a body is missing', () => {
    assert.deepEqual(compareBodies('doc', undefined, Buffer.from('x')), { compared: false });
  });
});

describe('versionsByDoc', () => {
  it('maps da versions to the live document through its id', () => {
    const res = versionsByDoc('da', [
      da('/index.html', { metadata: { id: 'U1' } }),
      da('/.da-versions/U1/V1.html', { metadata: { label: 'Release' } }),
      da('/.da-versions/U1/V2.html', { metadata: {} }),
    ]);
    assert.deepEqual(res, { '/index.html': { docId: 'U1', count: 2, labels: ['Release'] } });
  });
  it('maps hlx6 versions to trashed documents and keeps the operation', () => {
    const res = versionsByDoc('hlx6', [
      hx('/.trash/gone.html', { metadata: { 'doc-id': 'D1', 'doc-path': '/gone.html' } }),
      hx('/.versions/D1/V1', { metadata: { 'version-operation': 'delete' } }),
    ]);
    assert.deepEqual(res, { '/.trash/gone.html': { docId: 'D1', count: 1, labels: ['delete'] } });
  });
  it('reports orphans using the path hint stored on the version', () => {
    const res = versionsByDoc('hlx6', [
      hx('/.versions/D9/V1', { metadata: { 'doc-path-hint': '/purged.html', 'version-operation': 'delete' } }),
    ]);
    assert.deepEqual(Object.keys(res), ['(orphan) /purged.html']);
  });
  it('strips the site segment from da version path hints', () => {
    const res = versionsByDoc('da', [da('/.da-versions/U9/V1.html', { metadata: { path: 'site/old.html' } })]);
    assert.deepEqual(Object.keys(res), ['(orphan) /old.html']);
  });
});

describe('auditByDoc', () => {
  it('counts non-empty audit lines per document id', () => {
    const res = auditByDoc([
      da('/.da-versions/U1/audit.txt', { body: 'a\tb\tc\n\nd\te\tf\n' }),
      da('/.da-versions/U1/audit-1.txt', { body: 'g\th\ti\n' }),
    ]);
    assert.deepEqual(res, { U1: 3 });
  });
});

describe('compareDumps', () => {
  const daSide = [
    da('/index.html', { body: '<main>home</main>', metadata: { id: 'U1', users: '[{"email":"a@b.com"}]' } }),
    da('/My Page.html', { body: '<main>p</main>', metadata: { id: 'U2' } }),
    da('/folder.props', { body: '{}' }),
    da('/only-da.json', { body: '{}' }),
  ];
  const hlx6Side = [
    hx('/index.html', {
      body: '<main>home</main>', metadata: { 'doc-id': 'D1', 'uncompressed-length': '17' }, contentEncoding: 'gzip',
    }),
    hx('/my-page.html', { body: '<main>p</main>', metadata: { 'doc-id': 'D2' } }),
    hx('/folder/.props', { body: '{}' }),
    hx('/only-hlx6.html', { body: '<main/>' }),
  ];
  const report = compareDumps(daSide, hlx6Side);

  it('matches current content through the hlx6 path mapping', () => {
    assert.deepEqual(report.current.matched.map((m) => [m.daPath, m.hlx6Path, m.renamed]), [
      ['/index.html', '/index.html', false],
      ['/My Page.html', '/my-page.html', true],
      ['/folder', '/folder', false],
    ]);
    assert.equal(report.current.matched[0].body.equal, true);
    assert.equal(report.current.matched[0].size.hlx6Uncompressed, 17);
  });
  it('lists objects present on one side only', () => {
    assert.deepEqual(report.current.onlyDa, [{ kind: 'sheet', path: '/only-da.json', expectedHlx6Path: '/only-da.json' }]);
    assert.deepEqual(report.current.onlyHlx6, [{ kind: 'doc', path: '/only-hlx6.html' }]);
  });
  it('counts objects by kind on both sides', () => {
    assert.deepEqual(report.counts.da, { doc: 2, folder: 1, sheet: 1 });
    assert.deepEqual(report.counts.hlx6, { doc: 3, folder: 1 });
  });
  it('exposes normalized metadata shapes per kind', () => {
    assert.deepEqual(report.metadata.da.doc.keys, ['id', 'users']);
    assert.deepEqual(report.metadata.hlx6.doc.keys, ['doc-id', 'uncompressed-length']);
    assert.deepEqual(report.metadata.hlx6.doc.contentEncodings, ['gzip', 'none']);
    assert.ok(report.metadata.da.doc.examples.some((e) => e.users === '[{"email":"<email>"}]'));
  });
});
