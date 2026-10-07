import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOLS } from './protocol.ts';
import type { GameId } from './protocol.ts';
import { bucket } from './limits.ts';

export type Ctx = {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  login: string | null;
  sessionKey: string | null;
  ip: string;
  now: number;
  signal: AbortSignal;
};
export type Reply = { status: number; body?: unknown };
export type Route = {
  method: string;
  path: string;
  auth: boolean;
  game?: GameId;
  bodyLimit?: number;
  limit?: { ratePerSec: number; burst: number; by: 'ip' };
  handler: (ctx: Ctx) => Promise<Reply>;
};

const DEFAULT_BODY_LIMIT = 4096;
const NO_PROTOCOL = new Set(['/health', '/v1/config']);

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i]) return null;
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i]);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function createHandler(deps: {
  routes: Route[];
  findSession: (key: string, now: number) => string | null;
  trustProxy: boolean;
  now?: () => number;
  log?: (line: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const clock = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const perIp = bucket(20, 40);
  const perSession = bucket(12, 24);
  const routeBuckets = new Map(
    deps.routes.filter((r) => r.limit).map((r) => [r, bucket(r.limit!.ratePerSec, r.limit!.burst)]),
  );

  return (req, res) => {
    const start = clock();
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const ac = new AbortController();
    let pattern = path;
    let login: string | null = null;
    let sessionKey: string | null = null;

    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
      log(`${method} ${pattern} ${res.statusCode} ${login ?? '-'} ${clock() - start}ms`);
    });

    const send = (status: number, body?: unknown, closeAfter = false) => {
      if (res.headersSent || res.destroyed) return;
      const headers: Record<string, string> = {};
      if (closeAfter) headers.connection = 'close';
      if (body === undefined) {
        res.writeHead(status, headers);
        res.end(closeAfter ? () => req.destroy() : undefined);
        return;
      }
      headers['content-type'] = 'application/json';
      res.writeHead(status, headers);
      res.end(JSON.stringify(body), closeAfter ? () => req.destroy() : undefined);
    };

    // A reply sent before the body is read closes the connection so the unread body is never drained.
    const early = (status: number, body: unknown) => send(status, body, !req.complete);

    run().catch((err: unknown) => {
      log(`${method} ${pattern} 500 ${login ?? '-'} error=${err instanceof Error ? err.name : 'unknown'}`);
      send(500, { error: 'server error' });
    });

    async function run() {
      let route: Route | undefined;
      let params: Record<string, string> = {};
      let pathMatched = false;
      for (const r of deps.routes) {
        const p = matchPath(r.path, path);
        if (!p) continue;
        pathMatched = true;
        if (r.method === method) {
          route = r;
          params = p;
          break;
        }
      }
      if (!route) return early(pathMatched ? 405 : 404, { error: pathMatched ? 'method not allowed' : 'not found' });
      pattern = route.path;

      const header = req.headers['x-game'];
      const game = typeof header === 'string' ? header : 'block-battle';
      const want = Object.hasOwn(PROTOCOLS, game) ? PROTOCOLS[game as GameId] : null;
      if (
        !NO_PROTOCOL.has(path) &&
        (want === null || (route.game !== undefined && route.game !== game) || req.headers['x-protocol-version'] !== String(want))
      ) {
        return early(426, { error: `protocol ${PROTOCOLS[route.game ?? 'block-battle']} required` });
      }

      const fwd = req.headers['x-forwarded-for'];
      const forwarded = typeof fwd === 'string' ? (fwd.split(',').pop() ?? '').trim() : '';
      const ip = (deps.trustProxy && isIP(forwarded) ? forwarded : req.socket.remoteAddress) || 'unknown';
      const now = clock();
      if (!perIp.take(ip, now)) return early(429, { error: 'slow down' });
      const rb = routeBuckets.get(route);
      if (rb && !rb.take(ip, now)) return early(429, { error: 'slow down' });

      if (route.auth) {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
        login = m ? deps.findSession(m[1], now) : null;
        if (!login) return early(401, { error: 'sign in first' });
        sessionKey = m![1];
        if (!perSession.take(login, now)) return early(429, { error: 'slow down' });
      }

      const cap = route.bodyLimit ?? DEFAULT_BODY_LIMIT;
      const declared = Number(req.headers['content-length']);
      if (declared > cap) return send(413, { error: 'body too large' }, true);
      const chunks: Buffer[] = [];
      let size = 0;
      const tooBig = await new Promise<boolean>((resolve, reject) => {
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > cap) {
            req.removeAllListeners('data');
            resolve(true);
          } else chunks.push(c);
        });
        req.on('end', () => resolve(false));
        req.on('error', reject);
      });
      if (tooBig) return send(413, { error: 'body too large' }, true);

      let body: unknown = undefined;
      if (method !== 'GET' && method !== 'HEAD' && size > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: 'bad json' });
        }
      }

      const reply = await route.handler({ method, path, params, body, login, sessionKey, ip, now, signal: ac.signal });
      send(reply.status, reply.body);
    }
  };
}
