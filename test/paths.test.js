import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, splitExt, toHlx6Path } from '../src/paths.js';

describe('sanitizeName', () => {
  it('lowercases and replaces non alphanumeric runs with a dash', () => {
    assert.equal(sanitizeName('Hello World_Again'), 'hello-world-again');
  });
  it('strips accents', () => {
    assert.equal(sanitizeName('Café Crème'), 'cafe-creme');
  });
  it('trims leading and trailing dashes', () => {
    assert.equal(sanitizeName('  -draft- '), 'draft');
  });
});

describe('splitExt', () => {
  it('splits on the last dot', () => {
    assert.deepEqual(splitExt('archive.tar.gz'), { base: 'archive.tar', ext: '.gz' });
  });
  it('returns no extension for dotfiles and plain names', () => {
    assert.deepEqual(splitExt('.props'), { base: '.props', ext: '' });
    assert.deepEqual(splitExt('folder'), { base: 'folder', ext: '' });
  });
});

describe('toHlx6Path', () => {
  it('keeps already sanitized paths unchanged', () => {
    assert.equal(toHlx6Path('/folder/nested.html'), '/folder/nested.html');
    assert.equal(toHlx6Path('/index.html'), '/index.html');
  });
  it('sanitizes every folder segment and the basename', () => {
    assert.equal(toHlx6Path('/My Folder/Sub_Dir/Hello World.html'), '/my-folder/sub-dir/hello-world.html');
  });
  it('lowercases the extension', () => {
    assert.equal(toHlx6Path('/images/Logo.PNG'), '/images/logo.png');
  });
  it('maps dots inside a basename to dashes', () => {
    assert.equal(toHlx6Path('/v1.2/release.notes.json'), '/v1-2/release-notes.json');
  });
  it('sanitizes folder paths that have no extension', () => {
    assert.equal(toHlx6Path('/Empty Folder'), '/empty-folder');
  });
});
