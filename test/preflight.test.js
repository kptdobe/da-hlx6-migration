import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDa } from '../src/classify.js';
import { preflight } from '../src/preflight.js';

const da = (rel, metadata = {}) => ({ rel, ...classifyDa(rel), metadata });
const check = (result, id) => result.checks.find((c) => c.id === id);

describe('preflight', () => {
  it('passes a clean site', () => {
    const result = preflight([
      da('/index.html', { id: 'U1' }),
      da('/folder.props'),
      da('/folder/nested.html', { id: 'U2' }),
      da('/images/logo.png', { id: 'U3' }),
      da('/.da-versions/U1/V1.html'),
      da('/.da-versions/U1/audit.txt'),
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.checks.every((c) => c.count === 0));
  });

  it('blocks a site that has comments and lists the commented documents', () => {
    const result = preflight([
      da('/index.html', { id: 'U1' }),
      da('/.da/comments/U1/c1.json'),
      da('/.da/comments/U1/c2.json'),
      da('/.da/comments/U2/c1.json'),
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(check(result, 'comments'), {
      id: 'comments', severity: 'blocking', description: 'Comments exist (.da/comments) and are not migrated', count: 3, items: ['U1', 'U2'],
    });
  });

  it('blocks files with extensions hlx6 does not accept', () => {
    const result = preflight([da('/notes.txt', { id: 'U1' }), da('/feed.xml', { id: 'U2' })]);
    assert.equal(result.ok, false);
    assert.deepEqual(check(result, 'unsupported-extensions').items, ['/notes.txt', '/feed.xml']);
  });

  it('blocks paths that collide after sanitization', () => {
    const result = preflight([da('/my_page.html', { id: 'U1' }), da('/my-page.html', { id: 'U2' })]);
    assert.equal(result.ok, false);
    assert.deepEqual(check(result, 'path-collisions').items, [{ hlx6Path: '/my-page.html', paths: ['/my_page.html', '/my-page.html'] }]);
  });

  it('does not treat a folder and a same-named document as a collision', () => {
    const result = preflight([da('/news.props'), da('/news.html', { id: 'U1' })]);
    assert.equal(check(result, 'path-collisions').count, 0);
  });

  it('warns about renamed paths without blocking', () => {
    const result = preflight([da('/my_page.html', { id: 'U1' })]);
    assert.equal(result.ok, true);
    assert.deepEqual(check(result, 'renamed-paths').items, [{ from: '/my_page.html', to: '/my-page.html' }]);
  });

  it('warns about version folders of deleted documents', () => {
    const result = preflight([
      da('/index.html', { id: 'U1' }),
      da('/.da-versions/U1/V1.html'),
      da('/.da-versions/GONE/V1.html'),
      da('/.da-versions/GONE/audit.txt'),
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(check(result, 'orphan-versions').items, ['GONE']);
  });

  it('does not report versions of a trashed document as orphans', () => {
    const result = preflight([
      da('/.trash/old-2026-10-01t15-18-06-624z.html', { id: 'T1' }),
      da('/.da-versions/T1/audit.txt'),
    ]);
    assert.equal(check(result, 'orphan-versions').count, 0);
  });

  it('warns about objects with no hlx6 mapping', () => {
    const result = preflight([da('/img.jpg.props'), da('/.da/other.json')]);
    assert.deepEqual(check(result, 'unmapped-objects').items, ['/img.jpg.props', '/.da/other.json']);
  });
});
