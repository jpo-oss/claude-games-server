import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function start(config: { port: number }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const found = req.method === 'GET' && req.url === '/health';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(found ? { ok: true } : { error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (import.meta.main) {
  const { port } = await start({ port: Number(process.env.PORT ?? 8080) });
  console.log(`listening on ${port}`);
}
