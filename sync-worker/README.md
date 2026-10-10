# Tripping sync worker

Cloudflare Worker and D1 database for Tripping account sync. The static site on GitHub Pages talks to it with a bearer token. Passwords are stored only as a hash.

The public URL is `https://tripping-sync.tonychendds.workers.dev`. Browsers on `https://tonychendds.github.io` are allowed by CORS. Local `http://localhost` and `http://127.0.0.1` are allowed so the site can be tested against `wrangler dev`.

Each account has one JSON book of trips plus a revision number. `PUT /book` must send `baseRevision`. A stale revision gets `409` and the current book so the client can merge. An update that drops existing trips without a tombstone for each dropped id is also rejected with `409`.

## Deploy

From this folder, on a machine already logged in to the Cloudflare account:

```bash
npx wrangler d1 create tripping-sync
```

Copy the printed `database_id` into `wrangler.toml` (replace the placeholder), then:

```bash
npx wrangler d1 migrations apply tripping-sync --remote
npx wrangler deploy
```

No secrets are required. The site build only needs the public worker URL.
