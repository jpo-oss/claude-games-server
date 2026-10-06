import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket } from '../src/limits.ts';

test('allows a burst then refuses', () => {
  const b = bucket(1, 3);
  assert.deepEqual([0, 0, 0, 0].map((t) => b.take('a', t)), [true, true, true, false]);
});

test('refills over time', () => {
  const b = bucket(2, 2);
  b.take('a', 0);
  b.take('a', 0);
  assert.equal(b.take('a', 0), false);
  assert.equal(b.take('a', 500), true);
  assert.equal(b.take('a', 500), false);
});

test('keys are independent', () => {
  const b = bucket(1, 1);
  assert.equal(b.take('a', 0), true);
  assert.equal(b.take('b', 0), true);
  assert.equal(b.take('a', 0), false);
});

test('evicts the least recently used key past maxKeys', () => {
  const b = bucket(0.001, 1, 2);
  b.take('a', 0);
  b.take('b', 0);
  b.take('a', 1);
  b.take('c', 2);
  assert.equal(b.take('b', 3), true);
  assert.equal(b.take('c', 3), false);
});
