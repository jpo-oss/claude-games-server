export function bucket(ratePerSec: number, burst: number, maxKeys = 100_000) {
  const state = new Map<string, { tokens: number; at: number }>();
  return {
    take(key: string, now: number): boolean {
      const prev = state.get(key);
      const tokens = prev ? Math.min(burst, prev.tokens + ((now - prev.at) / 1000) * ratePerSec) : burst;
      const ok = tokens >= 1;
      state.delete(key);
      state.set(key, { tokens: ok ? tokens - 1 : tokens, at: now });
      if (state.size > maxKeys) state.delete(state.keys().next().value as string);
      return ok;
    },
  };
}
