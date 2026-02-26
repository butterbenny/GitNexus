import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeStringify } from '../dist/lib/safe-json.js';

test('safeStringify: serializes BigInt as string', () => {
  const text = safeStringify({ count: 1n }, 2);
  assert.equal(JSON.parse(text).count, '1');
});

test('safeStringify: handles nested BigInt values', () => {
  const text = safeStringify({ a: [2n], b: { c: 3n } }, 0);
  assert.deepEqual(JSON.parse(text), { a: ['2'], b: { c: '3' } });
});
