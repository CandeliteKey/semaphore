import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export interface ExtractedArticle {
  html: string;
  text: string;
  markdown: string;
  title: string;
}

const CHALLENGE_MARKERS = /(?:\bjust a moment\b|cf[-_]chl|\battention required\b|\bchecking your browser\b|\bdatadome\b|px-captcha|\bperimeterx\b|\bverifying you are human\b|enable javascript and cookies to continue)/i;

export function looksLikeChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.test(html);
}

const THIN_CONTENT_THRESHOLD = 240;
const SHORT_ARTICLE_THRESHOLD = 500;
const EXACT_CLUSTER_MIN_URLS = 8;
const EXACT_CLUSTER_MAX_COVERAGE = 0.5;
const PARENT_CLUSTER_MIN_URLS = 8;
const PARENT_CLUSTER_MAX_COVERAGE = 0.35;
const SHORT_CLUSTER_MIN_URLS = 6;
const SHORT_CLUSTER_MAX_COVERAGE = 0.25;
const REPEATED_ITEM_MIN_COUNT = 8;
const MAX_CLUSTER_URLS_PER_ITEM = 3;
// A links-worthy cluster must own a meaningful share of the page's distinct
// links. Measured: Seek search results ≈ 0.43, Wikipedia ISBN-citation cluster
// ≈ 0.014 — templated footnote links in long articles never dominate.
const CLUSTER_DOMINANCE_MIN = 0.1;
const CHROME_SELECTOR = "script, style, noscript, header, footer, nav, aside, iframe, svg, form";
const TRACKING_PARAM = /^(?:utm_.+|gclid|dclid|fbclid|msclkid|twclid|igshid|ref|referrer|source|campaign|mc_[a-z]+|_ga|ved|ei)$/i;
const LONG_ID_TOKEN = /(?:[a-f\d]{8,}|\d+)/gi;
const UNSTABLE_CLASS_TOKEN = /(?:[a-f\d]{8,}|\d{5,})/i;
const UUID_VALUE = /^[a-f\d]{8}-[a-f\d]{4}-[1-5a-f\d][a-f\d]{3}-[89abf\d][a-f\d]{3}-[a-f\d]{12}$/i;

export type ClassificationRule = "exact-template" | "parent-path" | "short-repeated" | "otherwise";

export interface ClassificationDetail {
  rule: ClassificationRule;
  distinctCount: number;
  coverage: number;
  structuralItemCount: number;
  dominance: number;
}

export interface PageClassification {
  mode: "article" | "links";
  detail: ClassificationDetail;
}

interface NormalizedAnchor {
  anchor: HTMLAnchorElement;
  identity: string;
  exactTemplate: string;
  parentTemplate: string;
}

interface Cluster {
  kind: "exact" | "parent";
  template: string;
  anchors: NormalizedAnchor[];
  identities: Set<string>;
  coverage: number;
  structuralItemCount: number;
  dominance: number;
}

function chromeStrippedDocument(html: string, url: string): Document {
  const document = new JSDOM(html, { url }).window.document;
  document.querySelectorAll(CHROME_SELECTOR).forEach((element) => element.remove());
  return document;
}

export function extractArticle(html: string, url: string): ExtractedArticle {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const content = article?.content?.trim() ?? "";
  const text = article?.textContent?.trim() ?? "";
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return {
    html: content,
    text,
    markdown: content ? turndown.turndown(content).trim() : "",
    title: article?.title?.trim() ?? ""
  };
}

export function extractLinkPreserving(html: string, url: string): { markdown: string; text: string } {
  const document = chromeStrippedDocument(html, url);
  const element = document.querySelector("main") ?? document.body;
  if (!element) return { markdown: "", text: "" };
  element.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    try {
      anchor.href = new URL(anchor.getAttribute("href") ?? "", url).href;
    } catch {
      // Leave malformed links unchanged so the rest of the page remains readable.
    }
  });
  return {
    markdown: new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(element.innerHTML).trim(),
    text: element.textContent?.trim() ?? ""
  };
}

function looksLikeId(value: string): boolean {
  if (UUID_VALUE.test(value) || /^[a-f\d]{8,}$/i.test(value)) return true;
  const digits = (value.match(/\d/g) ?? []).length;
  return digits >= 4 && digits * 2 >= value.length;
}

function normalizedUrl(href: string, baseUrl: string): { identity: string; exactTemplate: string; parentTemplate: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";

  const params = Array.from(parsed.searchParams.entries())
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  parsed.search = "";
  for (const [name, value] of params) parsed.searchParams.append(name, value);

  const templatePath = parsed.pathname.replace(LONG_ID_TOKEN, "#");
  const templateQuery = params.length === 0 ? "" : `?${params.map(([name, value]) => `${name}=${looksLikeId(value) ? "#" : "*"}`).join("&")}`;
  const segments = parsed.pathname.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]) {
      segments[index] = "*";
      break;
    }
  }
  return {
    identity: parsed.href,
    exactTemplate: `${parsed.origin}${templatePath}${templateQuery}`,
    parentTemplate: `${parsed.origin}${segments.join("/")}${templateQuery}`
  };
}

function collectAnchors(root: ParentNode, baseUrl: string): NormalizedAnchor[] {
  const result: NormalizedAnchor[] = [];
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const normalized = normalizedUrl(anchor.getAttribute("href") ?? "", baseUrl);
    if (normalized) result.push({ anchor, ...normalized });
  });
  return result;
}

function stableClasses(element: Element): string {
  return Array.from(element.classList).filter((token) => !UNSTABLE_CLASS_TOKEN.test(token)).sort().join(".");
}

function elementSignature(element: Element): string {
  const classes = stableClasses(element);
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
}

function relativeAnchorPath(item: Element, anchor: HTMLAnchorElement): string {
  const path: string[] = [];
  let current: Element | null = anchor;
  while (current && current !== item) {
    path.push(elementSignature(current));
    current = current.parentElement;
  }
  return path.reverse().join(">");
}

function descendantAtPath(item: Element, path: string): HTMLAnchorElement | undefined {
  const wanted = path.split(">");
  const visit = (element: Element, depth: number): HTMLAnchorElement | undefined => {
    if (elementSignature(element) !== wanted[depth]) return undefined;
    if (depth === wanted.length - 1) return element.tagName === "A" ? element as HTMLAnchorElement : undefined;
    for (const child of Array.from(element.children)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const child of Array.from(item.children)) {
    const found = visit(child, 0);
    if (found) return found;
  }
  return undefined;
}

function repeatedItemFor(anchor: HTMLAnchorElement): { item: Element; path: string; hasParagraphAncestor: boolean } | undefined {
  let candidate = anchor.parentElement;
  let hasParagraphAncestor = false;
  while (candidate && candidate.tagName !== "MAIN" && candidate.tagName !== "BODY") {
    const parent = candidate.parentElement;
    if (!parent) break;
    const signature = elementSignature(candidate);
    const path = relativeAnchorPath(candidate, anchor);
    const siblings = Array.from(parent.children).filter((sibling) =>
      elementSignature(sibling) === signature && descendantAtPath(sibling, path) !== undefined
    );
    if (siblings.length >= REPEATED_ITEM_MIN_COUNT) return { item: candidate, path, hasParagraphAncestor };
    if (candidate.tagName === "P") hasParagraphAncestor = true;
    candidate = parent;
  }
  return undefined;
}

function structuralItemCount(cluster: Cluster): number {
  const groups = new Map<string, Map<Element, Set<string>>>();
  const parentIds = new Map<Element, number>();
  let nextParentId = 0;
  for (const normalized of cluster.anchors) {
    const repeated = repeatedItemFor(normalized.anchor);
    if (!repeated || (cluster.kind === "parent" && repeated.hasParagraphAncestor)) continue;
    const parent = repeated.item.parentElement;
    if (!parent) continue;
    let parentId = parentIds.get(parent);
    if (parentId === undefined) {
      parentId = nextParentId++;
      parentIds.set(parent, parentId);
    }
    const key = `${parentId}|${elementSignature(repeated.item)}|${repeated.path}`;
    const items = groups.get(key) ?? new Map<Element, Set<string>>();
    const urls = items.get(repeated.item) ?? new Set<string>();
    urls.add(normalized.identity);
    items.set(repeated.item, urls);
    groups.set(key, items);
  }
  let best = 0;
  for (const items of groups.values()) {
    const qualifying = Array.from(items.values()).filter((urls) => urls.size <= MAX_CLUSTER_URLS_PER_ITEM).length;
    if (qualifying >= REPEATED_ITEM_MIN_COUNT) best = Math.max(best, qualifying);
  }
  return best;
}

function compareClusters(left: Cluster, right: Cluster): number {
  return right.identities.size - left.identities.size
    || right.structuralItemCount - left.structuralItemCount
    || left.template.localeCompare(right.template);
}

export function classifyPageDetailed(html: string, url: string, article: ExtractedArticle): PageClassification {
  const document = chromeStrippedDocument(html, url);
  const bodyAnchors = document.body ? collectAnchors(document.body, url) : [];
  const articleDocument = new JSDOM(article.html, { url }).window.document;
  const articleIdentities = new Set(collectAnchors(articleDocument, url).map((anchor) => anchor.identity));
  const maps = { exact: new Map<string, NormalizedAnchor[]>(), parent: new Map<string, NormalizedAnchor[]>() };
  for (const anchor of bodyAnchors) {
    const exactEntries = maps.exact.get(anchor.exactTemplate) ?? [];
    exactEntries.push(anchor);
    maps.exact.set(anchor.exactTemplate, exactEntries);

    const repeated = repeatedItemFor(anchor.anchor);
    if (!repeated || repeated.hasParagraphAncestor) continue;
    const parentEntries = maps.parent.get(anchor.parentTemplate) ?? [];
    parentEntries.push(anchor);
    maps.parent.set(anchor.parentTemplate, parentEntries);
  }
  const totalIdentities = new Set(bodyAnchors.map((anchor) => anchor.identity)).size;
  const clusters: Cluster[] = [];
  for (const kind of ["exact", "parent"] as const) {
    for (const [template, anchors] of maps[kind]) {
      const identities = new Set(anchors.map((anchor) => anchor.identity));
      const articleCount = Array.from(identities).filter((identity) => articleIdentities.has(identity)).length;
      const cluster: Cluster = {
        kind, template, anchors, identities,
        coverage: identities.size === 0 ? 0 : articleCount / identities.size,
        structuralItemCount: 0,
        dominance: totalIdentities === 0 ? 0 : identities.size / totalIdentities
      };
      cluster.structuralItemCount = structuralItemCount(cluster);
      clusters.push(cluster);
    }
  }

  // The thresholds deliberately lean moderately toward link-preserving output:
  // losing a list's result data is worse than producing noisier article markdown.
  // Structural gates on the broader rules keep ordinary prose links protected.
  // The parent-path rule is intentionally absent: measured on Wikipedia, the
  // /wiki/* parent template clusters the whole article (distinct 474-544,
  // dominance 0.55-0.61, structural_items 71 — navboxes and reference lists ARE
  // repeated structure), so no gate distinguishes it from a slug-ID result list.
  // Slug-only-ID list pages are an accepted miss until a real one shows up.
  const rules: Array<{ name: ClassificationRule; matches: (cluster: Cluster) => boolean }> = [
    { name: "exact-template", matches: (cluster) => cluster.kind === "exact" && cluster.identities.size >= EXACT_CLUSTER_MIN_URLS && cluster.coverage < EXACT_CLUSTER_MAX_COVERAGE },
    { name: "short-repeated", matches: (cluster) => cluster.kind === "exact" && cluster.identities.size >= SHORT_CLUSTER_MIN_URLS && cluster.coverage < SHORT_CLUSTER_MAX_COVERAGE && cluster.structuralItemCount >= REPEATED_ITEM_MIN_COUNT && article.text.length < SHORT_ARTICLE_THRESHOLD }
  ];
  for (const rule of rules) {
    const winner = clusters.filter((cluster) => cluster.dominance >= CLUSTER_DOMINANCE_MIN && rule.matches(cluster)).sort(compareClusters)[0];
    if (winner) return { mode: "links", detail: { rule: rule.name, distinctCount: winner.identities.size, coverage: winner.coverage, structuralItemCount: winner.structuralItemCount, dominance: winner.dominance } };
  }

  const best = [...clusters].sort(compareClusters)[0];
  return { mode: "article", detail: { rule: "otherwise", distinctCount: best?.identities.size ?? 0, coverage: best?.coverage ?? 0, structuralItemCount: best?.structuralItemCount ?? 0, dominance: best?.dominance ?? 0 } };
}

export function classifyPage(html: string, url: string, article: ExtractedArticle): "article" | "links" {
  return classifyPageDetailed(html, url, article).mode;
}

// Thin content justifies escalating to browser rendering (the page may be an
// SPA shell), but on its own it must never be read as a login wall — plenty of
// legitimate pages are short.
export function isThinContent(text: string): boolean {
  return text.length < THIN_CONTENT_THRESHOLD;
}

export function hasLoginMarkers(html: string, text: string): boolean {
  const lowerHtml = html.toLowerCase();
  const lowerText = text.toLowerCase();
  const passwordFields = (lowerHtml.match(/type\s*=\s*["']?password/g) ?? []).length;
  const loginForms = (lowerHtml.match(/<form[^>]+(?:login|signin|sign-in|auth)/g) ?? []).length;
  const loginPhrases = (lowerText.match(/\b(?:log in|login|sign in|session expired|authentication required)\b/g) ?? []).length;
  const words = lowerText.split(/\s+/).filter(Boolean).length;
  return passwordFields > 0 || loginForms > 0 || (loginPhrases >= 2 && words < 500);
}
