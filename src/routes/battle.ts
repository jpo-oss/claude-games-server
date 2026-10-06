import type { Arena } from '../arena.ts';
import type { Route } from '../http.ts';
import { parseLogBody, parseSyncBody } from '../protocol.ts';

export function battleRoutes(arena: Arena): Route[] {
  return [
    {
      method: 'POST',
      path: '/v1/battle/queue',
      auth: true,
      handler: async (ctx) => arena.join(ctx.login!),
    },
    {
      method: 'DELETE',
      path: '/v1/battle/queue',
      auth: true,
      handler: async (ctx) => arena.leave(ctx.login!),
    },
    {
      method: 'POST',
      path: '/v1/battle/:room/sync',
      auth: true,
      handler: async (ctx) => {
        const parsed = parseSyncBody(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        return arena.sync(ctx.params.room!, ctx.login!, parsed.value, ctx.signal);
      },
    },
    {
      method: 'POST',
      path: '/v1/battle/:room/log',
      auth: true,
      bodyLimit: 1_572_864,
      handler: async (ctx) => {
        const parsed = parseLogBody(ctx.body);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
        return arena.log(ctx.params.room!, ctx.login!, parsed.value.log);
      },
    },
  ];
}
