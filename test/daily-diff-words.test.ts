import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWords } from '../src/daily-diff/words.ts';
import { wordDir } from './words.ts';

test('keeps five-letter words, lowercases, dedupes; answers count as guesses', () => {
  const w = loadWords(wordDir('qqqqa\nQQQQB\n\n  qqqqc \nbad\nqqqqa\n', 'zzzza\nzzzzb\n'))!;
  assert.deepEqual(w.answers, ['qqqqa', 'qqqqb', 'qqqqc']);
  assert.equal(w.isWord('zzzza'), true);
  assert.equal(w.isWord('qqqqa'), true);
  assert.equal(w.isWord('zzzzz'), false);
});

test('missing dir, missing file or no answers gives null', () => {
  assert.equal(loadWords(undefined), null);
  assert.equal(loadWords(join(tmpdir(), 'dd-none-here')), null);
  assert.equal(loadWords(wordDir('\n', 'zzzza\n')), null);
});
