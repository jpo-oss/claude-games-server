import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayEnd, dayOf, marks, monthStart, weekStart } from '../src/daily-diff/rules.ts';

test('marks greens first, then yellows only while the answer has that letter left', () => {
  assert.equal(marks('qwert', 'qwert'), 'ggggg');
  assert.equal(marks('qwert', 'asdfz'), 'xxxxx');
  assert.equal(marks('aabbb', 'xaxax'), 'ygxxx');
  assert.equal(marks('bbbaa', 'xaxax'), 'xxxgy');
  assert.equal(marks('ccccc', 'xxcxx'), 'xxgxx');
  assert.equal(marks('ababa', 'baaab'), 'yygyy');
  assert.equal(marks('eeexx', 'xexee'), 'ygyyy');
});

test('days are UTC dates; weeks start Monday', () => {
  assert.equal(dayOf(Date.UTC(2026, 9, 7, 23, 59, 59, 999)), '2026-10-07');
  assert.equal(dayOf(Date.UTC(2026, 9, 8)), '2026-10-08');
  assert.equal(dayEnd('2026-10-07'), Date.UTC(2026, 9, 8));
  assert.equal(weekStart('2026-10-07'), '2026-10-05');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(monthStart('2026-10-07'), '2026-10-01');
});
