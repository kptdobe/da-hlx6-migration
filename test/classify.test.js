import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDa, classifyHlx6, isSupportedOnHlx6 } from '../src/classify.js';

describe('classifyDa', () => {
  it('classifies documents, sheets and media by extension', () => {
    assert.deepEqual(classifyDa('/index.html'), { kind: 'doc', path: '/index.html' });
    assert.deepEqual(classifyDa('/sample.json'), { kind: 'sheet', path: '/sample.json' });
    assert.deepEqual(classifyDa('/images/img.jpg'), { kind: 'media', path: '/images/img.jpg' });
  });
  it('treats a sibling .props file as a folder marker', () => {
    assert.deepEqual(classifyDa('/folder.props'), { kind: 'folder', path: '/folder' });
    assert.deepEqual(classifyDa('/a/b.props'), { kind: 'folder', path: '/a/b' });
  });
  it('treats file.ext.props as a sidecar, not a folder', () => {
    assert.deepEqual(classifyDa('/img.jpg.props'), { kind: 'props-sidecar', path: '/img.jpg.props' });
  });
  it('classifies version snapshots with doc id and version id', () => {
    assert.deepEqual(
      classifyDa('/.da-versions/08eb0a3a-d3b3-4cbc-bf43-ee80f859f2ab/240b027a-5af1-4388-be34-574a8fa0574c.html'),
      { kind: 'version', docId: '08eb0a3a-d3b3-4cbc-bf43-ee80f859f2ab', versionId: '240b027a-5af1-4388-be34-574a8fa0574c' },
    );
  });
  it('classifies audit logs, including archived ones', () => {
    assert.deepEqual(classifyDa('/.da-versions/abc/audit.txt'), { kind: 'audit', docId: 'abc' });
    assert.deepEqual(classifyDa('/.da-versions/abc/audit-1700000000000.txt'), { kind: 'audit', docId: 'abc' });
  });
  it('classifies comments and other .da internals', () => {
    assert.deepEqual(classifyDa('/.da/comments/doc1/c1.json'), { kind: 'comment', docId: 'doc1' });
    assert.deepEqual(classifyDa('/.da/config.json'), { kind: 'da-internal', path: '/.da/config.json' });
  });
  it('classifies trashed items with their original kind', () => {
    assert.deepEqual(
      classifyDa('/.trash/to-be-deleted-2026-10-01t15-18-06-624z.html'),
      { kind: 'trash', path: '/to-be-deleted-2026-10-01t15-18-06-624z.html', trashedKind: 'doc' },
    );
    assert.deepEqual(classifyDa('/.trash/old.props'), { kind: 'trash', path: '/old.props', trashedKind: 'folder' });
  });
});

describe('classifyHlx6', () => {
  it('treats a child .props file as a folder marker', () => {
    assert.deepEqual(classifyHlx6('/folder/.props'), { kind: 'folder', path: '/folder' });
  });
  it('classifies versions without extension', () => {
    assert.deepEqual(
      classifyHlx6('/.versions/01M3VP8ZE44TMDMRTE5AZZFS1F/01M3VY15VYNZ2YGDDAE49Y5Z5Z'),
      { kind: 'version', docId: '01M3VP8ZE44TMDMRTE5AZZFS1F', versionId: '01M3VY15VYNZ2YGDDAE49Y5Z5Z' },
    );
  });
  it('classifies trashed objects with their original kind', () => {
    assert.deepEqual(classifyHlx6('/.trash/to-be-deleted.html'), { kind: 'trash', path: '/to-be-deleted.html', trashedKind: 'doc' });
    assert.deepEqual(classifyHlx6('/.trash/old/.props'), { kind: 'trash', path: '/old/.props', trashedKind: 'folder' });
  });
  it('classifies current content by extension', () => {
    assert.deepEqual(classifyHlx6('/nav.html'), { kind: 'doc', path: '/nav.html' });
    assert.deepEqual(classifyHlx6('/images/logo.svg'), { kind: 'media', path: '/images/logo.svg' });
  });
});

describe('isSupportedOnHlx6', () => {
  it('accepts the hlx6 extension list case-insensitively', () => {
    assert.equal(isSupportedOnHlx6('/a/b.HTML'), true);
    assert.equal(isSupportedOnHlx6('/doc.pdf'), true);
  });
  it('rejects other extensions', () => {
    assert.equal(isSupportedOnHlx6('/notes.txt'), false);
    assert.equal(isSupportedOnHlx6('/feed.xml'), false);
    assert.equal(isSupportedOnHlx6('/noext'), false);
  });
});
