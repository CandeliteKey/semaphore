import { firefox, type BrowserContext } from "playwright";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CookieStore, FirefoxCookie, StoredDomain } from "../cookies.js";
import { findStoredDomain } from "../cookies.js";
import { classifyPageDetailed, extractArticle, extractLinkPreserving, hasLoginMarkers, isThinContent, looksLikeChallenge, type ClassificationDetail, type ExtractedArticle } from "./extract.js";
import { domainRateLimiter } from "./rate-limiter.js";

export type PageFormat = "auto" | "markdown" | "html" | "aria";

export class FetchFailure extends Error {
  constructor(message: string, readonly kind: "session" | "fetch") { super(message); }
}

export type AuthReason = "no_cookies" | "session_expired";

// Distinct from FetchFailure: the fetch itself succeeded but landed on a login
// wall. The caller must halt and have the user re-clip cookies — retrying or
// reading the logged-out page is never the right recovery.
export class AuthRequiredError extends Error {
  constructor(readonly domain: string, readonly reason: AuthReason) {
    super(`authentication required for ${domain} (${reason})`);
  }
}

export interface FetchPageResult {
  text: string;
  tier: 1 | 2;
  hadCookies: boolean;
  mode?: "article" | "links";
}

function cookieApplies(cookie: FirefoxCookie, url: URL): boolean {
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  const domainMatches = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  const pathMatches = url.pathname.startsWith(cookie.path);
  const unexpired = cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000;
  return domainMatches && pathMatches && unexpired && (!cookie.secure || url.protocol === "https:");
}

function cookieHeader(cookies: FirefoxCookie[], url: URL): string | undefined {
  const value = cookies.filter((cookie) => cookieApplies(cookie, url)).map(({ name, value }) => `${name}=${value}`).join("; ");
  return value || undefined;
}

export function firefoxHeaders(userAgent: string | undefined, acceptLanguage: string | undefined): Record<string, string> | undefined {
  if (userAgent === undefined || !/Firefox\/\d/.test(userAgent)) return undefined;
  // Sec-Fetch-* are deliberately omitted. Node's fetch (undici) forces
  // Sec-Fetch-Mode to "cors" regardless of what we set, and a document/user
  // navigation carrying Mode: cors is a combination no real browser emits — a
  // contradictory set fingerprints worse than an absent one. We send only the
  // headers undici relays verbatim (verified against an echo endpoint).
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8",
    "accept-language": acceptLanguage ?? "en-US,en;q=0.5",
    "upgrade-insecure-requests": "1",
    "priority": "u=0, i"
  };
}

async function tierOne(url: URL, session: StoredDomain | undefined, fallbackUa: string | undefined, fallbackAcceptLanguage: string | undefined): Promise<{ article: ExtractedArticle; html: string; finalUrl: string; authStatus: boolean }> {
  let current = url;
  for (let redirects = 0; redirects <= 10; redirects += 1) {
    const headers = new Headers();
    const cookies = session ? cookieHeader(session.cookies, current) : undefined;
    if (cookies) headers.set("cookie", cookies);
    const userAgent = session?.userAgent ?? fallbackUa;
    if (userAgent) headers.set("user-agent", userAgent);
    const acceptLanguage = session?.acceptLanguage ?? fallbackAcceptLanguage;
    const coherentHeaders = firefoxHeaders(userAgent, acceptLanguage);
    if (coherentHeaders) {
      for (const [name, value] of Object.entries(coherentHeaders)) headers.set(name, value);
    }
    const response = await fetch(current, { method: "GET", headers, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new FetchFailure(`redirect from ${current.hostname} had no location`, "fetch");
      const next = new URL(location, current);
      if (next.origin !== url.origin) throw new FetchFailure(`cross-origin redirect blocked (${url.origin} to ${next.origin})`, "session");
      current = next;
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new FetchFailure(`HTTP ${response.status}`, "session");
    if (!response.ok) throw new FetchFailure(`HTTP ${response.status} ${response.statusText}`, "fetch");
    const html = await response.text();
    return { article: extractArticle(html, current.href), html, finalUrl: current.href, authStatus: /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(current.pathname) };
  }
  throw new FetchFailure("too many redirects", "fetch");
}

type AddCookieParam = Parameters<BrowserContext["addCookies"]>[0][number];

function toPlaywrightCookie(cookie: FirefoxCookie): AddCookieParam {
  const sameSite =
    cookie.sameSite === "strict" ? "Strict"
    : cookie.sameSite === "lax" ? "Lax"
    : cookie.sameSite === "no_restriction" ? "None"
    : undefined;
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    secure: cookie.secure, httpOnly: cookie.httpOnly,
    ...(sameSite === undefined ? {} : { sameSite }),
    ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate })
  };
}

let persistentContext: Promise<BrowserContext> | undefined;

function getPersistentContext(dataDir: string, userAgent: string | undefined, acceptLanguage: string | undefined): Promise<BrowserContext> {
  const locale = acceptLanguage?.split(",", 1)[0]?.trim();
  persistentContext ??= firefox.launchPersistentContext(path.join(dataDir, "profile"), {
    headless: true,
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(locale ? { locale } : {})
  }).catch((error: unknown) => {
    persistentContext = undefined;
    throw error;
  });
  return persistentContext;
}

async function tierTwo(dataDir: string, url: URL, format: PageFormat, session: StoredDomain | undefined, fallbackUa: string | undefined, fallbackAcceptLanguage: string | undefined): Promise<{ text: string; loginWall: boolean; mode?: "article" | "links"; classification?: ClassificationDetail }> {
  const context = await getPersistentContext(dataDir, fallbackUa ?? session?.userAgent, fallbackAcceptLanguage ?? session?.acceptLanguage);
  const page = await context.newPage();
  try {
    if (session) await context.addCookies(session.cookies.map(toPlaywrightCookie));
    const userAgent = fallbackUa ?? session?.userAgent;
    if (userAgent) await page.setExtraHTTPHeaders({ "user-agent": userAgent });
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const authStatus = response?.status() === 401 || response?.status() === 403;
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    const html = await page.content();
    if (looksLikeChallenge(html)) throw new FetchFailure(`blocked by an anti-bot challenge that needs an interactive browser (${url.hostname})`, "fetch");
    if (authStatus) return { text: "", loginWall: true };
    if (format === "aria") {
      const aria = await page.locator("html").ariaSnapshot();
      const article = extractArticle(html, page.url());
      return { text: aria, loginWall: hasLoginMarkers(html, article.text) || /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(page.url()) };
    }
    const article = extractArticle(html, page.url());
    const classification = format === "auto" ? classifyPageDetailed(html, page.url(), article) : undefined;
    const mode = classification?.mode;
    return {
      text: format === "html" ? article.html
        : mode === "links" ? extractLinkPreserving(html, page.url()).markdown
        : article.markdown,
      ...(mode === undefined ? {} : { mode }),
      ...(classification === undefined ? {} : { classification: classification.detail }),
      loginWall: hasLoginMarkers(html, article.text) || /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(page.url())
    };
  } finally {
    await page.close();
  }
}

function isPrivateAddress(ip: string): boolean {
  const low = ip.toLowerCase();
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  if (low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  if (low.startsWith("127.") || low.startsWith("10.") || low.startsWith("169.254.") || low.startsWith("192.168.") || low.startsWith("0.")) return true;
  const twelve = low.match(/^172\.(\d+)\./);
  return twelve?.[1] !== undefined && Number(twelve[1]) >= 16 && Number(twelve[1]) <= 31;
}

// SSRF guard: once /mcp is reachable beyond this host, read_page must not become
// a pivot into loopback / private / link-local networks. Rejects if ANY resolved
// address is private (defeats split-horizon rebinding to a public+private pair).
// Known gap: TOCTOU between this lookup and the actual fetch (DNS rebinding).
async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new FetchFailure("refusing to fetch a loopback address", "fetch");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new FetchFailure(`could not resolve ${host}`, "fetch");
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new FetchFailure(`refusing to fetch a private or loopback address (${host})`, "fetch");
  }
}

export async function fetchPage(dataDir: string, store: CookieStore, rawUrl: string, format: PageFormat): Promise<FetchPageResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchFailure("only http and https URLs are supported", "fetch");
  await assertPublicUrl(url);
  const match = findStoredDomain(store, url.hostname);
  const session = match?.[1];

  return domainRateLimiter.run(url.hostname, async () => {
    if (format !== "aria") {
      try {
        const normalizedSession = session === undefined ? undefined : {
          ...session,
          userAgent: store.userAgent ?? session.userAgent,
          acceptLanguage: store.acceptLanguage ?? session.acceptLanguage
        };
        const first = await tierOne(url, normalizedSession, store.userAgent, store.acceptLanguage);
        const thin = format === "auto"
          ? isThinContent(first.article.text) && isThinContent(extractLinkPreserving(first.html, first.finalUrl).text)
          : isThinContent(first.article.text);
        if (!first.authStatus && !hasLoginMarkers(first.article.html, first.article.text) && !thin && !looksLikeChallenge(first.html)) {
          const classification = format === "auto" ? classifyPageDetailed(first.html, first.finalUrl, first.article) : undefined;
          const mode = classification?.mode;
          const text = format === "html" ? first.article.html
            : mode === "links" ? extractLinkPreserving(first.html, first.finalUrl).markdown
            : first.article.markdown;
          if (classification !== undefined) console.log(`read_page mode=${mode} tier=1 rule=${classification.detail.rule} cluster_distinct=${classification.detail.distinctCount} coverage=${classification.detail.coverage.toFixed(2)} structural_items=${classification.detail.structuralItemCount} dominance=${classification.detail.dominance.toFixed(2)}`);
          return { text, tier: 1, hadCookies: session !== undefined, ...(mode === undefined ? {} : { mode }) };
        }
      } catch (error: unknown) {
        if (!(error instanceof FetchFailure) || error.kind !== "session") throw error;
      }
    }
    const second = await tierTwo(dataDir, url, format, session === undefined ? undefined : {
      ...session,
      userAgent: store.userAgent ?? session.userAgent,
      acceptLanguage: store.acceptLanguage ?? session.acceptLanguage
    }, store.userAgent, store.acceptLanguage);
    if (second.loginWall) throw new AuthRequiredError(url.hostname, session !== undefined ? "session_expired" : "no_cookies");
    if (second.mode !== undefined && second.classification !== undefined) console.log(`read_page mode=${second.mode} tier=2 rule=${second.classification.rule} cluster_distinct=${second.classification.distinctCount} coverage=${second.classification.coverage.toFixed(2)} structural_items=${second.classification.structuralItemCount} dominance=${second.classification.dominance.toFixed(2)}`);
    return { text: second.text, tier: 2, hadCookies: session !== undefined, ...(second.mode === undefined ? {} : { mode: second.mode }) };
  });
}
