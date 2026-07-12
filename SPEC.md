# semaphore — Spec v1

Read-only authenticated web-fetch layer for LLM agents. Runs as a Docker container
inside WSL2, exposes an MCP server over streamable HTTP on `127.0.0.1:8931`. A
companion Firefox/Zen extension ("Cookie Clip") posts session cookies for
user-selected domains into the container, so agents can read login-walled pages
without ever holding credentials. No write/click/submit capability in v1 — the
tool surface is the enforcement boundary.

## Architecture

```
Windows Zen (Firefox) ──(extension "Cookie Clip")──POST──▶ localhost:8931/api/cookies
                                                                │
WSL2: Docker container "semaphore"                              ▼
  ├─ HTTP server, bound 127.0.0.1:8931 (compose publishes 127.0.0.1:8931:8931)
  │    ├─ POST /api/cookies   ← cookie ingestion, shared-secret auth
  │    └─ ALL  /mcp           ← MCP streamable HTTP endpoint
  ├─ MCP tools (read-only surface, exactly two in v1):
  │    ├─ read_page({ url, format? })   format: "auto" (default) | "markdown" | "aria" | "html"
  │    │                                 auto uses Readability for article-like pages and link-preserving markdown for link-list-like pages
  │    └─ session_status({ domain? })
  ├─ Two-tier fetch:
  │    tier 1: plain HTTP GET + Cookie header + UA string matching user's Zen
  │    tier 2: Playwright **Firefox** persistent context (headless) — only when
  │            tier 1 output is thin / looks like a login wall or SPA shell
  ├─ Extraction: @mozilla/readability (via jsdom for tier 1) → turndown → markdown
  ├─ Cookie store: JSON file on /data volume; injected into Playwright context
  │    via addCookies; expiry tracked per domain
  └─ Rate limiter: per-domain serial queue, min interval ~5s + jitter
```

## Components

- `server/` — TypeScript (strict), Node 22. Minimal deps:
  `@modelcontextprotocol/sdk`, `playwright` (firefox only), `@mozilla/readability`,
  `jsdom`, `turndown`. HTTP framework: keep it light (hono or express, implementer's
  choice).
- `extension/` — Firefox WebExtension for Zen. `browser.cookies.getAll` for the
  active tab's domain (captures HttpOnly cookies), per-domain opt-in UI in popup,
  POST to `http://localhost:8931/api/cookies` with the shared secret.
  Signature requirement is disabled in the user's Zen, so a plain zip/xpi is fine.
- `docker/` or root — Dockerfile (node:22 + Playwright Firefox deps) and
  `compose.yaml` with a named volume mounted at `/data` (cookie store + browser
  profile). Container restarts must not lose sessions.

## Security constraints (non-negotiable)

- Bind `127.0.0.1` only. Never `0.0.0.0`.
- `POST /api/cookies` requires header `X-Semaphore-Secret`; secret generated at
  first boot, stored under `/data`, surfaced in container logs for the user to
  copy into the extension settings.
- Cookies are the only stored credential material. No passwords anywhere.
- MCP surface is read-only: no tool may navigate via form submission, click, or
  any non-GET action.

## Build order (chunks)

1. Repo scaffold: TS strict config, package layout, Dockerfile + compose.yaml,
   HTTP server skeleton with `/api/cookies` (secret auth, stores payload) and
   `/mcp` MCP endpoint with both tools registered as stubs.
2. Cookie store + two-tier fetch + extraction pipeline + per-domain rate limiter.
3. Wire `read_page` / `session_status` to the real pipeline; login-wall
   heuristics; error shape for "session expired for domain X".
4. Zen/Firefox extension.
5. Integration: Windows-Zen → WSL localhost reachability, end-to-end read of a
   real authenticated page.

## v1 non-goals

- No click/write/form-fill tools (job applications stay human-confirmed).
- No proxy rotation / anti-bot evasion beyond real-session + real-UA coherence.
- No container-tab (cookieStoreId) selection in the extension (default store
  only; add later if needed).
- No multi-user support. Single local user.
