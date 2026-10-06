const API = 'https://api.github.com';
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export type GithubUser = { login: string; id: number; createdAt: number };
export type Github = { verify(token: string): Promise<GithubUser | null> };

export function createGithub(deps: {
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}): Github {
  const timeout = deps.timeoutMs ?? 10_000;
  const basic = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64');
  const common = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

  return {
    async verify(token) {
      const check = await deps.fetch(`${API}/applications/${encodeURIComponent(deps.clientId)}/token`, {
        method: 'POST',
        headers: { ...common, authorization: `Basic ${basic}`, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(timeout),
      });
      await check.body?.cancel();
      if (check.status === 404 || check.status === 422) return null;
      if (check.status !== 200) throw new Error(`github check-token ${check.status}`);

      const res = await deps.fetch(`${API}/user`, {
        headers: { ...common, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 401) {
        await res.body?.cancel();
        return null;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`github user ${res.status}`);
      }
      const u = (await res.json()) as { login?: unknown; id?: unknown; created_at?: unknown };
      const createdAt = typeof u.created_at === 'string' ? Date.parse(u.created_at) : NaN;
      if (typeof u.login !== 'string' || !LOGIN.test(u.login)) return null;
      if (typeof u.id !== 'number' || !Number.isInteger(u.id) || u.id <= 0) return null;
      if (!Number.isFinite(createdAt)) return null;
      return { login: u.login, id: u.id, createdAt };
    },
  };
}
