import { createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value, length) {
  let remainder = BigInt(value);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result = ALPHABET[Number(remainder & 31n)] + result;
    remainder >>= 5n;
  }
  return result;
}

export function deterministicUlid(timestamp, seed) {
  const time = Math.max(0, Math.min(Number(timestamp) || 0, 281474976710655));
  const digest = createHash('sha256').update(String(seed)).digest();
  const random = BigInt(`0x${digest.subarray(0, 10).toString('hex')}`);
  return `${encode(time, 10)}${encode(random, 16)}`;
}