import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicUlid } from '../src/ulid.js';

describe('deterministicUlid', () => {
  it('returns a stable 26-character ULID for the same timestamp and seed', () => {
    const first = deterministicUlid(1790864889099, 'da-id:08eb');
    assert.equal(first.length, 26);
    assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(first, deterministicUlid(1790864889099, 'da-id:08eb'));
  });

  it('sorts lexically by timestamp and differentiates seeds at the same time', () => {
    const earlier = deterministicUlid(1000, 'version:a');
    const later = deterministicUlid(2000, 'version:b');
    assert.ok(earlier < later);
    assert.notEqual(earlier, deterministicUlid(1000, 'version:b'));
  });
});