import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORD } from './rules.ts';

export type Words = { answers: string[]; isWord(w: string): boolean };

const read = (path: string) => [
  ...new Set(readFileSync(path, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => WORD.test(l))),
];

export function loadWords(dir: string | undefined): Words | null {
  if (!dir) return null;
  try {
    const answers = read(join(dir, 'answers.txt'));
    const guesses = new Set([...read(join(dir, 'guesses.txt')), ...answers]);
    return answers.length ? { answers, isWord: (w) => guesses.has(w) } : null;
  } catch {
    return null;
  }
}
