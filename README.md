# claude-games-server

Game server for Block Battle, a falling-block game that runs inside Claude Code. It handles sign-in, the marathon leaderboard and head-to-head battles, and checks scores and wins by replaying the games. The game itself lives in [jpo-oss/claude-games](https://github.com/jpo-oss/claude-games). Players can point it at any server, so you can run your own.

## What you need

- A Linux machine with Docker and Docker Compose
- A domain name you can point at that machine
- Ports 80 and 443 open to the internet
- A GitHub account

## Set up

1. Register a GitHub OAuth app for your server. Go to GitHub Settings, Developer settings, OAuth Apps, New OAuth App. Set the homepage URL to `https://<your domain>` and the callback URL to the same value (it is never used). Check "Enable Device Flow", create the app, then generate a client secret. Keep the client ID and the secret.

   Every server needs its own app: the server checks each player's token against its own app, so a token issued for one server can't sign in on another.

2. Get the files. Either clone this repo, or download `compose.yaml`, `Caddyfile` and `.env.example` into an empty folder. Copy `.env.example` to `.env` and fill in `DOMAIN`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

3. Point your domain's DNS at the machine. Caddy fetches the HTTPS certificate on first start, so the record has to resolve before you continue.

4. Start it.

   ```sh
   docker compose up -d
   curl https://<your domain>/health
   ```

   The check should print `{"ok":true}`.

5. Tell your players. In Block Battle they pick Battle, choose "Enter a server address", and type `https://<your domain>`. They can also set it as their default in the plugin settings.

## Updating

```sh
docker compose pull && docker compose up -d
```

To stay on a release, set `SERVER_VERSION` in `.env` to a tag such as `1.2.0`. It defaults to `latest`.

## Backups

All data is one SQLite file in the `server-data` volume. To copy it while the server is running, use SQLite's backup:

```sh
docker compose exec server node -e "const { DatabaseSync, backup } = require('node:sqlite'); backup(new DatabaseSync('/data/server.db'), '/data/backup.db').then(() => console.log('done'))"
docker compose cp server:/data/backup.db ./backup-$(date +%F).db
docker compose exec server rm /data/backup.db
```

Or stop the server for a moment (`docker compose stop server`), copy the file out with `docker compose cp`, and start it again.

Keep copies somewhere other than the machine itself. To restore, stop the server and put the file back at `/data/server.db`.

## Behind a CDN or another proxy

Caddy ignores an incoming `X-Forwarded-For` header unless it trusts the sender. If you put a CDN or another proxy in front of Caddy, every player then looks like the proxy's address and they all share one rate limit. In the `Caddyfile`, set `trusted_proxies` (with `trusted_proxies_strict`) to the proxy's published IP ranges:

```
{
	servers {
		trusted_proxies static <ip ranges>
		trusted_proxies_strict
	}
}
```

See the [Caddy reverse_proxy docs](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#trusted_proxies) for the details.

## What's stored and logged

Stored: GitHub login and numeric ID, the date the account was created, hashed session keys, scores and battle results. Your GitHub token is checked once at sign-in and not kept.

Logged: method, route, status, login and duration for each request. Tokens, request bodies and IP addresses are never logged.

## Limits and tuning

Set these in `.env`. Only the first three are listed in `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_CLIENT_ID` | none, required | Your OAuth app's client ID |
| `GITHUB_CLIENT_SECRET` | none, required | Your OAuth app's client secret. Used only to check tokens with GitHub |
| `MAX_PLAYERS` | `1000` | Players in the queue or in battles. New players get a "server busy" reply past this |
| `MAX_HELD` | `2000` | Open waiting sync requests. Past this, requests are answered at once instead of waiting |
| `MAX_CONNECTIONS` | `4000` | Open connections the server accepts |
| `TRUST_PROXY` | `false` | Read the player's address from `X-Forwarded-For`. The compose file turns it on because Caddy is in front. Only enable it behind a proxy you control |
| `PORT` | `8080` | Port the server listens on. Caddy expects 8080 |
| `DATABASE_PATH` | `./data/server.db` | SQLite file. The container uses `/data/server.db` |

Per-address and per-player rate limits are built in.

## Running without Docker

You need Node 24 or newer.

```sh
npm ci
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... npm start
```

Set the other variables above the same way. The server speaks plain HTTP, so put your own HTTPS proxy in front of it and set `TRUST_PROXY=true` if that proxy sets `X-Forwarded-For`.

## Development

```sh
npm test
npm run typecheck
npm run check-engine
npm run load -- --players 500 --seconds 60
```

`npm run load` starts a server in-process with fake GitHub sign-in and simulated players, then prints latency and error counts. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest.

## License

MIT
