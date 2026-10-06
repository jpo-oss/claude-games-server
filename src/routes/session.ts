import type { Db } from '../db.ts';
import type { Github } from '../github.ts';
import type { Route } from '../http.ts';
import { PROTOCOL_VERSION, parseSessionBody } from '../protocol.ts';
import type { ConfigReply, SessionReply } from '../protocol.ts';

export function sessionRoutes(deps: { db: Db; github: Github; clientId: string }): Route[] {
  return [
    {
      method: 'GET',
      path: '/v1/config',
      auth: false,
      handler: async () => {
        const body: ConfigReply = { githubClientId: deps.clientId, protocol: PROTOCOL_VERSION };
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/session',
      auth: false,
      limit: { ratePerSec: 5 / 60, burst: 5, by: 'ip' },
      handler: async (ctx) => {
        const parsed = parseSessionBody(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        let user;
        try {
          user = await deps.github.verify(parsed.value.githubToken);
        } catch {
          return { status: 502, body: { error: 'github unavailable' } };
        }
        if (!user) return { status: 401, body: { error: 'sign-in rejected' } };
        deps.db.upsertPlayer({ login: user.login, githubId: user.id, githubCreatedAt: user.createdAt }, ctx.now);
        const body: SessionReply = { session: deps.db.createSession(user.login, ctx.now), login: user.login };
        return { status: 200, body };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/session',
      auth: true,
      handler: async (ctx) => {
        if (ctx.sessionKey) deps.db.deleteSession(ctx.sessionKey);
        return { status: 204 };
      },
    },
  ];
}
