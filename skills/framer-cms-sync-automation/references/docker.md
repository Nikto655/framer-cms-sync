# Docker

The image runs the HTTP API and MCP over HTTP, with the CLI and terminal app on the `PATH` inside the container.

## Start

```bash
docker build -t framer-cms-sync .
docker run -d --name framer-cms-sync \
  -v "$PWD/my-site:/config" \
  -p 127.0.0.1:8080:8080 \
  framer-cms-sync
```

Or use `docker compose -f examples/docker-compose.yml up -d`.

- **`/config` holds** `framer-cms-sync.config.yaml`, `.env`, local state and the run log. Mount a folder there so they survive restarts.
- **Data files** (CSV, Excel, Markdown) referenced by relative paths go in the same folder.

## First-time setup inside the container

```bash
docker exec -it framer-cms-sync sh
```

Any interactive shell in the container opens the terminal app straight away, including Docker Desktop's Exec tab. Quit it with `q` to reach the shell. In the app: add a site, create an access token, create syncs. On a fresh volume the service waits in setup mode (`/health` answers, and the log says what's missing). It starts serving as soon as a site and a token exist, with no restart.

Every CLI command works the same way:

```bash
docker exec framer-cms-sync framer-cms-sync plan pricing
docker exec framer-cms-sync framer-cms-sync tokens add n8n --scope write
docker exec -it -e FRAMER_CMS_SYNC_NO_TUI=1 framer-cms-sync sh   # a shell without the app
```

## Networking

- **Publish the port on `127.0.0.1` only.** Docker's port publishing bypasses host firewalls such as UFW.
- **On the same Docker network as n8n,** call it as `http://framer-cms-sync:8080`.
- **For remote access,** put it behind a reverse proxy with HTTPS. Tokens are bearer secrets.

## Health

- **`GET /health`** returns `{ ok: true, syncs: […] }`, with no token needed.
- **The image has a built-in healthcheck** against it.

## Updating

Rebuild or pull the image and recreate the container. Everything you set up lives in `/config`.
