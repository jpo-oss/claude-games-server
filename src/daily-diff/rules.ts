const DAY = 24 * 3600 * 1000;
export const WORD = /^[a-z]{5}$/;
export const MAX_GUESSES = 6;

export function marks(guess: string, answer: string): string {
  const out = ['x', 'x', 'x', 'x', 'x'];
  const left = new Map<string, number>();
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) out[i] = 'g';
    else left.set(answer[i]!, (left.get(answer[i]!) ?? 0) + 1);
  }
  for (let i = 0; i < 5; i++) {
    const n = left.get(guess[i]!) ?? 0;
    if (out[i] !== 'g' && n > 0) {
      out[i] = 'y';
      left.set(guess[i]!, n - 1);
    }
  }
  return out.join('');
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayEnd = (day: string) => Date.parse(`${day}T00:00:00Z`) + DAY;
export function weekStart(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return dayOf(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
}
export const monthStart = (day: string) => `${day.slice(0, 8)}01`;
