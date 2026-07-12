import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DATA_DIR } from "./config.js";
import { loadCookieStore, normalizeDomain, type StoredDomain } from "./cookies.js";
import { fetchPage, type PageFormat } from "./fetcher/index.js";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: "read_page_failed", message });
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "semaphore", version: "0.1.0" });

  server.tool(
    "read_page",
    "Read a public or authenticated web page without performing any write action.",
    {
      url: z.string().url(),
      format: z.enum(["markdown", "aria", "html"]).default("markdown")
    },
    async ({ url, format }) => {
      try {
        const store = await loadCookieStore(DATA_DIR);
        const result = await fetchPage(DATA_DIR, store, url, format as PageFormat);
        const note = result.hadCookies ? "" : `[No cookies stored for domain; fetched as a public page.]\n\n`;
        return { content: [{ type: "text" as const, text: `${note}${result.text}` }] };
      } catch (error: unknown) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    }
  );

  server.tool(
    "session_status",
    "Report stored cookie-session status for one domain or all domains.",
    { domain: z.string().min(1).optional() },
    async ({ domain }) => {
      try {
        const store = await loadCookieStore(DATA_DIR);
        const now = Date.now() / 1000;
        const entries: Array<[string, StoredDomain | undefined]> = domain === undefined
          ? Object.entries(store.domains)
          : [[normalizeDomain(domain), store.domains[normalizeDomain(domain)]]];
        const sessions = entries.map(([name, entry]) => {
          if (entry === undefined) return { domain: name, stored: false, cookieCount: 0 };
          const expiries = entry.cookies
            .map((cookie) => cookie.expirationDate)
            .filter((expiry): expiry is number => expiry !== undefined && expiry > now);
          const earliestExpiry = expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null;
          return {
            domain: name, stored: true, cookieCount: entry.cookies.length,
            earliestRelevantExpiry: earliestExpiry,
            userAgent: store.userAgent ?? entry.userAgent ?? null,
            updatedAt: entry.updatedAt
          };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(domain === undefined ? { sessions } : sessions[0], null, 2) }] };
      } catch (error: unknown) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "session_status_failed", message: error instanceof Error ? error.message : String(error) }) }], isError: true };
      }
    }
  );

  return server;
}

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  parsedBody: unknown
): Promise<void> {
  // Stateless mode: the SDK requires a fresh server+transport pair per request;
  // reusing one transport breaks every request after the first.
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, parsedBody);
}
