import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, splitExt, toHlx6Path } from '../src/paths.js';

describe('sanitizeName', () => {
  it('preserves a leading dot and the remaining name verbatim', () => {
    assert.equal(sanitizeName('.drafts'), '.drafts');
    assert.equal(sanitizeName('.My_Folder'), '.My_Folder');
    assert.equal(sanitizeName('.release.notes'), '.release.notes');
  });
  it('preserves case, spaces, and punctuation', () => {
    assert.equal(sanitizeName('Hello World_Again'), 'Hello World_Again');
    assert.equal(sanitizeName('logo@2x%20(1)'), 'logo@2x%20(1)');
  });
  it('preserves leading, trailing, and repeated underscores', () => {
    assert.equal(sanitizeName('_Drafts_'), '_Drafts_');
    assert.equal(sanitizeName('image__one_'), 'image__one_');
    assert.equal(sanitizeName('._Hidden__Name_'), '._Hidden__Name_');
    assert.equal(sanitizeName('_'), '_');
  });
  it('preserves accents', () => {
    assert.equal(sanitizeName('Café Crème'), 'Café Crème');
  });
  it('preserves leading and trailing spaces and dashes', () => {
    assert.equal(sanitizeName('  -draft- '), '  -draft- ');
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
    assert.equal(toHlx6Path('/.My Folder/.Hello_World.JSON'), '/.My Folder/.Hello_World.JSON');
    assert.equal(toHlx6Path('/.da/config.json'), '/.da/config.json');
    assert.equal(toHlx6Path('/.drafts'), '/.drafts');
    assert.equal(toHlx6Path('/.da.json'), '/.da.json');
  });
  it('keeps ordinary paths unchanged', () => {
    assert.equal(toHlx6Path('/folder/nested.html'), '/folder/nested.html');
    assert.equal(toHlx6Path('/index.html'), '/index.html');
  });
  it('preserves every folder segment and the basename', () => {
    assert.equal(toHlx6Path('/My Folder/Sub_Dir/Hello World.html'), '/My Folder/Sub_Dir/Hello World.html');
  });
  it('preserves underscores in folders and filenames', () => {
    assert.equal(toHlx6Path('/_drafts_/sub__dir/.page_one_.html'), '/_drafts_/sub__dir/.page_one_.html');
  });
  it('preserves extension case', () => {
    assert.equal(toHlx6Path('/images/Logo.PNG'), '/images/Logo.PNG');
  });
  it('preserves interior dots', () => {
    assert.equal(toHlx6Path('/v1.2/release.notes.json'), '/v1.2/release.notes.json');
  });
  it('preserves folder paths that have no extension', () => {
    assert.equal(toHlx6Path('/Empty Folder'), '/Empty Folder');
  });
  it('preserves percent escapes, accents, and punctuation without decoding', () => {
    const path = '/Café @Home/jordan%20den%c3%a9 (1).html';
    assert.equal(toHlx6Path(path), path);
  });
});
