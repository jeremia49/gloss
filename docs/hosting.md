# Hosting Gloss on the internet

Gloss has no built-in login for local use. This deployment adds a password gate
and automatic HTTPS in front of the same app:

```text
iPad ── HTTPS ──> Caddy (80/443) ── private Docker network ──> Gloss (:8010)
```

Only Caddy is exposed. The Gloss port is never published to the host or the
internet. `GLOSS_REQUIRE_AUTH=1` prevents the container from starting without a
password.

## Requirements

- A Linux server with Docker Engine 24+ and Docker Compose v2.
- `GLOSS_PASSWORD` must be at least 12 characters (use `openssl rand -hex 24`).
- A DNS `A` (and optionally `AAAA`) record for the hostname pointing at the server.
- Inbound TCP 80 and 443 (and UDP 443 for HTTP/3) open in the firewall.
- No other web server using ports 80/443.

## Deploy

```bash
git clone https://github.com/computersniper/gloss.git
cd gloss

cp .env.example .env
# Edit .env: set GLOSS_DOMAIN and a long random GLOSS_PASSWORD.
# Generate one with: openssl rand -hex 24

docker compose up -d --build
docker compose logs -f caddy
```

Open `https://<your-domain>` on the iPad. Caddy obtains and renews the TLS
certificate automatically. Sign in with `GLOSS_USERNAME` and `GLOSS_PASSWORD`.

If the certificate is still being issued, wait for Caddy's log line containing
`certificate obtained successfully`.

## First-run configuration

1. Open the site and sign in.
2. Open a paper, go to **Settings → Provider**, and choose `Anthropic API` or
   `Local API` (`OpenAI`-compatible).
3. Enter the API key and base URL, then save and test the connection.

The Docker image intentionally does not include the `claude` or `codex` CLI
binaries, so the `local_claude` / `local_codex` providers are not available in
the container. Use an API provider, or extend the image if you need a CLI.

Keys and papers live in the persistent `gloss-data` volume at `/data`. The
`config.json` in that volume contains provider keys; treat backups accordingly.

## Operations

```bash
# status / logs
docker compose ps
docker compose logs -f gloss

# update
git pull
docker compose up -d --build

# back up papers, database, plugins and settings
docker run --rm -v gloss_gloss-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/gloss-backup.tgz -C /data .

# sign out on this browser
open https://<your-domain>/logout
```

Sessions last `GLOSS_SESSION_DAYS` (default 30). They are signed with a secret
stored in the data volume plus the current password, so changing either
`GLOSS_PASSWORD` or `GLOSS_SECRET_KEY` invalidates every existing session.

## Without Docker

Run Gloss behind an existing HTTPS reverse proxy, bound to loopback only:

```bash
GLOSS_PASSWORD='a-long-random-password' \
GLOSS_REQUIRE_AUTH=1 \
npm start -- --host 127.0.0.1 --port 8010
```

Configure the proxy to forward to `http://127.0.0.1:8010` and to send
`X-Forwarded-Proto` / `X-Forwarded-For`. For Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8010;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;          # AI responses stream
    proxy_read_timeout 3600s;
    client_max_body_size 100m;    # PDF uploads
}
```

Do not expose port 8010 directly. Without TLS the password and session cookie
travel in cleartext.

## Security notes

- Gloss plugins run in the server process. Install only plugins you trust.
- The login endpoint is rate-limited per client IP (10 failures per 10 minutes).
  Behind a reverse proxy, forwarded headers must be enabled for this to see real
  client addresses (the provided Docker command does).
- This is a single shared password, not multi-user accounts. Anyone with the
  password can read all papers and change provider settings.
- Keep the host patched, and do not commit `.env` (it is gitignored).