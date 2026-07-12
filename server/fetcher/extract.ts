import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export interface ExtractedArticle {
  html: string;
  text: string;
  markdown: string;
  title: string;
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

// Thin content justifies escalating to browser rendering (the page may be an
// SPA shell), but on its own it must never be read as a login wall — plenty of
// legitimate pages are short.
export function isThinContent(text: string): boolean {
  return text.length < 240;
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
