# semaphore

A read-only MCP server that reads login-walled web pages by replaying cookies
clipped from your own browser. You log into a site normally; a browser extension
sends that site's cookies to a local server; an LLM agent calls `read_page` over
MCP and gets clean markdown back. Credentials never reach the agent — only the
server holds the cookies, and it can only read (GET), never submit.

Binds `127.0.0.1:8931`. Runs in Docker. Fetches with a plain HTTP GET first and
falls back to headless Playwright Firefox only when a page needs JavaScript.

## Requirements

- Docker + Docker Compose
- A Firefox-based browser (Firefox / Zen) that can load an unsigned extension
- An MCP client that speaks streamable HTTP (e.g. Claude Code)

## 1. Run the server

```bash
docker compose up -d --build
docker logs semaphore | grep "shared secret"   # copy this value
```

The shared secret is generated on first boot and printed to the logs. Cookies,
the secret, and the Playwright profile live in the `semaphore-data` Docker volume,
so they survive restarts. The secret is the auth token for both endpoints — treat
it as a credential.

## 2. Load the Cookie Clip extension

In Firefox/Zen, open `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → select `extension/manifest.json`. (Temporary add-ons unload when the
browser restarts. To keep it, package `extension/` as an unsigned `.xpi` — this
requires `xpinstall.signatures.required = false`. See `extension/README.md`.)

Open the extension popup once and paste the shared secret into it. It is stored in
`browser.storage.local` and reused for every clip.

## 3. Clip cookies for a site

1. Log into the target site in your browser as normal.
2. Open the Cookie Clip popup. It shows the active tab's registrable domain.
3. Confirm or edit the domain, then click **Clip cookies**.

This sends the domain's cookies (including HttpOnly) plus your browser's
user-agent to `POST /api/cookies`. Re-clip whenever a session expires.

> The domain box defaults to the last two labels of the hostname, which is wrong
> for multi-part TLDs like `example.co.uk` — edit it by hand in that case.

## 4. Register the server with your MCP client

```bash
claude mcp add --transport http semaphore http://localhost:8931/mcp \
  --header "X-Semaphore-Secret: <secret>"
```

Both `/mcp` and `/api/cookies` require the `X-Semaphore-Secret` header.

## Tools

### `read_page({ url, format? })`

Fetches `url` and returns it as text. `format`:

- `auto` (default) — detects article vs link-list pages and renders each well
  (Readability for articles, link-preserving markdown for search/result lists).
- `markdown` — force pure Readability article extraction.
- `aria` — accessibility-tree snapshot (Playwright). Use this if `auto`
  misclassifies a list page and drops its links.
- `html` — Readability's cleaned HTML.

On a login wall it returns a structured error instead of page content:

```json
{ "error": "auth_required", "domain": "…", "reason": "no_cookies" | "session_expired", "action": "…" }
```

`no_cookies` = nothing clipped for that domain; `session_expired` = clipped
cookies no longer authenticate. Re-clip and retry — do not treat the logged-out
page as the answer.

### `session_status({ domain? })`

Reports stored domains, cookie counts, earliest cookie expiry, and stored
user-agent. Never returns cookie values. Omit `domain` for all domains.

## Remote access over a tailnet (optional)

Keep the server bound to localhost. On the host running Tailscale, expose only the
`/mcp` path over HTTPS:

```bash
tailscale serve --bg --set-path /mcp http://localhost:8931/mcp
```

(Flag names vary by Tailscale version — check `tailscale serve --help`.) Then
point a remote MCP client at `https://<machine>.<tailnet>.ts.net/mcp` with the
same secret header. `/api/cookies` stays local, so cookies never leave the host,
and all fetches egress from the host's IP. Restrict reach with Tailscale ACLs.

## Configuration

- `SEMAPHORE_DATA_DIR` — data directory (default `/data` in the container).
- `SEMAPHORE_HOST` — bind address (default `127.0.0.1`). Do not bind `0.0.0.0`;
  use `tailscale serve` for remote access instead.
- Port is fixed at `8931`.
- Rotate the secret by deleting `/data/secret` and restarting; re-enter it in the
  extension and MCP client.

## Layout (for modifying)

| Path | What it does |
|------|--------------|
| `server/index.ts` | HTTP server; `/api/cookies` + `/mcp` routing; shared-secret auth |
| `server/mcp.ts` | MCP tool definitions (`read_page`, `session_status`) |
| `server/fetcher/index.ts` | Two-tier fetch (HTTP → Playwright Firefox), SSRF guard, rate limiter, `auth_required` |
| `server/fetcher/extract.ts` | Readability + link-preserving extraction; article-vs-list classifier |
| `server/cookies.ts` | Per-domain cookie store (`/data/cookies.json`) |
| `server/rate-limiter.ts` | Per-domain serial queue |
| `extension/` | The Cookie Clip WebExtension |
| `SPEC.md` | Full design spec and rationale |

Local dev without Docker: `npm install`, then `npm run dev` (needs Node 22; set
`SEMAPHORE_DATA_DIR` to a writable path). `npm run build` type-checks.

## Limitations

- Cookies are frozen at clip time — there is no server-side session refresh. When
  a site rotates or expires its session, re-clip.
- Read-only by design: no form submission, clicking, or applying. Discovery works
  because most search is GET (`?keywords=…`); the final action stays manual.
- The `auto` classifier misses list pages whose item URLs have no numeric/hex id
  (pure slugs) — use `format: "aria"` for those.
- Self-hosted: no proxy rotation or anti-bot handling. It is meant for reading
  your own authenticated sessions, from your own IP.
- Automated reading of authenticated content may violate a site's terms. Use it
  for sessions you are entitled to, and within those terms.
