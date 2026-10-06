# claude-games-server

Game server for Block Battle, a falling-block game that runs inside Claude Code as a plugin (see jpo-oss/claude-games). One Node process, plain `node:http`, TypeScript run directly by Node.

```sh
npm start          # run the server
npm test           # node --test
npm run typecheck  # tsc --noEmit
```

## Rules

- Node runs the `.ts` files directly (type stripping), so: explicit `.ts` import extensions, `import type` for types, no enums, namespaces or parameter properties.
- No runtime dependencies. Dev dependencies only, added with `npm i -D <pkg>@latest`.
- Nothing about any particular deployment (provider, region, hostnames, deploy targets) goes in this repo, including the maintainers' own.
- Writing: plain and short. No em dashes, no emojis. Comments only where the code can't explain itself.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...).

Behind a proxy, set TRUST_PROXY=true only if the proxy appends the client address to X-Forwarded-For.
