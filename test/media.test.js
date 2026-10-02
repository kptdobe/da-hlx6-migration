import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mediaHash } from '../src/media.js';

describe('mediaHash', () => {
  it('prefixes "1" to the sha1 of the length and the content', () => {
    const buf = Buffer.from('hello');
    const expected = crypto.createHash('sha1').update('5').update(buf).digest('hex');
    assert.equal(mediaHash(buf), `1${expected}`);
  });

  it('only hashes the first 8 KiB, but the full length', () => {
    const a = Buffer.alloc(10000, 1);
    const b = Buffer.concat([Buffer.alloc(8192, 1), Buffer.alloc(1808, 2)]);
    assert.equal(mediaHash(a), mediaHash(b));
    assert.notEqual(mediaHash(a), mediaHash(Buffer.alloc(10001, 1)));
  });

  it('produces 41 hex characters starting with 1', () => {
    assert.match(mediaHash(Buffer.alloc(20000, 7)), /^1[0-9a-f]{40}$/);
  });
});
