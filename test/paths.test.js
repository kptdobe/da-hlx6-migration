import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, splitExt, toHlx6Path } from '../src/paths.js';

describe('sanitizeName', () => {
  it('preserves a leading dot while normalizing the remaining name', () => {
    assert.equal(sanitizeName('.drafts'), '.drafts');
    assert.equal(sanitizeName('.My_Folder'), '.my_folder');
    assert.equal(sanitizeName('.release.notes'), '.release-notes');
  });
  it('lowercases and replaces unsupported character runs with a dash', () => {
    assert.equal(sanitizeName('Hello World_Again'), 'hello-world_again');
  });
  it('preserves leading, trailing, and repeated underscores', () => {
    assert.equal(sanitizeName('_Drafts_'), '_drafts_');
    assert.equal(sanitizeName('image__one_'), 'image__one_');
    assert.equal(sanitizeName('._Hidden__Name_'), '._hidden__name_');
    assert.equal(sanitizeName('_'), '_');
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
  it('preserves hidden directories and file basenames without special cases', () => {
    assert.equal(toHlx6Path('/.drafts/.config/.page.html'), '/.drafts/.config/.page.html');
    assert.equal(toHlx6Path('/.My Folder/.Hello_World.JSON'), '/.my-folder/.hello_world.json');
    assert.equal(toHlx6Path('/.da/config.json'), '/.da/config.json');
    assert.equal(toHlx6Path('/.drafts'), '/.drafts');
    assert.equal(toHlx6Path('/.da.json'), '/.da.json');
  });
  it('keeps already sanitized paths unchanged', () => {
    assert.equal(toHlx6Path('/folder/nested.html'), '/folder/nested.html');
    assert.equal(toHlx6Path('/index.html'), '/index.html');
  });
  it('sanitizes every folder segment and the basename', () => {
    assert.equal(toHlx6Path('/My Folder/Sub_Dir/Hello World.html'), '/my-folder/sub_dir/hello-world.html');
  });
  it('preserves underscores in folders and filenames', () => {
    assert.equal(toHlx6Path('/_drafts_/sub__dir/.page_one_.html'), '/_drafts_/sub__dir/.page_one_.html');
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
