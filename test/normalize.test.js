import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeValue, normalizeMetadata, normalizeHtml } from '../src/normalize.js';

describe('normalizeValue', () => {
  it('masks ULIDs and UUIDs', () => {
    assert.equal(normalizeValue('01M3VP8ZE44TMDMRTE5AZZFS1F'), '<ulid>');
    assert.equal(normalizeValue('08eb0a3a-d3b3-4cbc-bf43-ee80f859f2ab'), '<uuid>');
  });
  it('masks ISO dates and epoch milliseconds', () => {
    assert.equal(normalizeValue('2026-10-01T16:31:27.123Z'), '<iso-date>');
    assert.equal(normalizeValue('1759336287123'), '<epoch-ms>');
  });
  it('masks emails inside JSON strings', () => {
    assert.equal(normalizeValue('[{"email":"acapt@adobe.com"}]'), '[{"email":"<email>"}]');
  });
  it('leaves stable values untouched', () => {
    assert.equal(normalizeValue('/folder/nested.html'), '/folder/nested.html');
    assert.equal(normalizeValue('Restore Point'), 'Restore Point');
  });
});

describe('normalizeMetadata', () => {
  it('normalizes values and sorts keys', () => {
    assert.deepEqual(
      normalizeMetadata({ 'last-modified-by': 'a@b.com', 'doc-id': '01M3VP8ZE44TMDMRTE5AZZFS1F' }),
      { 'doc-id': '<ulid>', 'last-modified-by': '<email>' },
    );
  });
  it('returns an empty object for missing metadata', () => {
    assert.deepEqual(normalizeMetadata(undefined), {});
  });
});

describe('normalizeHtml', () => {
  it('ignores whitespace between tags and collapses runs', () => {
    assert.equal(normalizeHtml('<body>\n  <main>\n    <p>a   b</p>\n  </main>\n</body>\n'), '<body><main><p>a b</p></main></body>');
  });
});
