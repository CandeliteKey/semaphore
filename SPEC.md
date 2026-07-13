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
  │    └─ ALL  /mcp           ← MCP streamable HTTP endpoint, shared-secret auth
  ├─ MCP tools (read-only surface, exactly two in v1):
  │    ├─ read_page({ url, format? })   format: "auto" (default) | "markdown" | "aria" | "html"
  │    │                                 auto uses Readability for article-like pages and link-preserving markdown for link-list-like pages
  │    │                                 on a login wall returns a structured error { error: "auth_required", domain,
  │    │                                 reason: "no_cookies" | "session_expired", action }; the caller must halt and
  │    │                                 have the user re-clip, never retry or read the logged-out page
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

Tier 1 sends the Firefox headers undici relays verbatim (Accept, Accept-Language
from the clip, Upgrade-Insecure-Requests, Priority). Sec-Fetch-* are omitted:
undici forces Sec-Fetch-Mode to "cors", which would contradict a document
navigation, and a contradictory set fingerprints worse than none. Anti-bot
challenge pages automatically escalate to tier 2's real Firefox; tier 1 cannot
match browser TLS/JA3 (or Sec-Fetch-Mode) by design.

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

- Bind `127.0.0.1` only. Never `0.0.0.0`. To reach it from a tailnet, front the
  `/mcp` path with `tailscale serve` (HTTPS, tailnet-only) rather than rebinding;
  keep `/api/cookies` unexposed so cookie writes stay loopback-only.
- Both `POST /api/cookies` and `/mcp` require header `X-Semaphore-Secret`; secret
  generated at first boot, stored under `/data`, surfaced in container logs. The
  extension and any MCP client must send it. `/mcp` auth is defense-in-depth so
  that bind/ACL is not the only thing standing between a caller and the sessions.
- Cookies are the only stored credential material. No passwords anywhere. No tool
  returns raw cookie values — `session_status` reports counts/expiry only.
- MCP surface is read-only: no tool may navigate via form submission, click, or
  any non-GET action.
- SSRF guard: `read_page` refuses URLs resolving to loopback / private / link-local
  addresses, so it cannot be used as a pivot into the host's internal network.

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
