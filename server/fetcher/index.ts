import { firefox, type BrowserContext } from "playwright";
import path from "node:path";
import type { CookieStore, FirefoxCookie, StoredDomain } from "../cookies.js";
import { findStoredDomain } from "../cookies.js";
import { extractArticle, hasLoginMarkers, isThinContent, type ExtractedArticle } from "./extract.js";
import { domainRateLimiter } from "./rate-limiter.js";

export type PageFormat = "markdown" | "html" | "aria";

export class FetchFailure extends Error {
  constructor(message: string, readonly kind: "session" | "fetch") { super(message); }
}

export interface FetchPageResult {
  text: string;
  tier: 1 | 2;
  hadCookies: boolean;
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

async function tierOne(url: URL, session: StoredDomain | undefined, fallbackUa: string | undefined): Promise<{ article: ExtractedArticle; authStatus: boolean }> {
  let current = url;
  for (let redirects = 0; redirects <= 10; redirects += 1) {
    const headers = new Headers();
    const cookies = session ? cookieHeader(session.cookies, current) : undefined;
    if (cookies) headers.set("cookie", cookies);
    const userAgent = session?.userAgent ?? fallbackUa;
    if (userAgent) headers.set("user-agent", userAgent);
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
    return { article: extractArticle(html, current.href), authStatus: /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(current.pathname) };
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

function getPersistentContext(dataDir: string, userAgent: string | undefined): Promise<BrowserContext> {
  persistentContext ??= firefox.launchPersistentContext(path.join(dataDir, "profile"), {
    headless: true,
    ...(userAgent === undefined ? {} : { userAgent })
  }).catch((error: unknown) => {
    persistentContext = undefined;
    throw error;
  });
  return persistentContext;
}

async function tierTwo(dataDir: string, url: URL, format: PageFormat, session: StoredDomain | undefined, fallbackUa: string | undefined): Promise<{ text: string; loginWall: boolean }> {
  const context = await getPersistentContext(dataDir, fallbackUa ?? session?.userAgent);
  const page = await context.newPage();
  try {
    if (session) await context.addCookies(session.cookies.map(toPlaywrightCookie));
    const userAgent = fallbackUa ?? session?.userAgent;
    if (userAgent) await page.setExtraHTTPHeaders({ "user-agent": userAgent });
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
    if (response?.status() === 401 || response?.status() === 403) return { text: "", loginWall: true };
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (format === "aria") {
      const aria = await page.locator("html").ariaSnapshot();
      const html = await page.content();
      const article = extractArticle(html, page.url());
      return { text: aria, loginWall: hasLoginMarkers(html, article.text) || /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(page.url()) };
    }
    const html = await page.content();
    const article = extractArticle(html, page.url());
    return {
      text: format === "html" ? article.html : article.markdown,
      loginWall: hasLoginMarkers(html, article.text) || /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(page.url())
    };
  } finally {
    await page.close();
  }
}

export async function fetchPage(dataDir: string, store: CookieStore, rawUrl: string, format: PageFormat): Promise<FetchPageResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchFailure("only http and https URLs are supported", "fetch");
  const match = findStoredDomain(store, url.hostname);
  const session = match?.[1];

  return domainRateLimiter.run(url.hostname, async () => {
    if (format !== "aria") {
      try {
        const first = await tierOne(url, session === undefined ? undefined : { ...session, userAgent: store.userAgent ?? session.userAgent }, store.userAgent);
        if (!first.authStatus && !hasLoginMarkers(first.article.html, first.article.text) && !isThinContent(first.article.text)) {
          return { text: format === "html" ? first.article.html : first.article.markdown, tier: 1, hadCookies: session !== undefined };
        }
      } catch (error: unknown) {
        if (!(error instanceof FetchFailure) || error.kind !== "session") throw error;
      }
    }
    const second = await tierTwo(dataDir, url, format, session, store.userAgent);
    if (second.loginWall) throw new FetchFailure(`session expired or missing for domain ${url.hostname} — re-clip cookies from the browser extension`, "session");
    return { text: second.text, tier: 2, hadCookies: session !== undefined };
  });
}
