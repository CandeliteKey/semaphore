import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DATA_DIR, HOST, PORT } from "./config.js";
import { storeCookiePayload } from "./cookies.js";
import { handleMcpRequest } from "./mcp.js";
import { loadOrCreateSecret } from "./secret.js";

const MAX_BODY_BYTES = 1_048_576;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isAuthorized(candidate: string | undefined, secret: string): boolean {
  if (candidate === undefined) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const { secret, created } = await loadOrCreateSecret(DATA_DIR);
console.log(`[semaphore] shared secret${created ? " generated" : " loaded"}: ${secret}`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (pathname === "/api/cookies") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return json(response, 405, { error: "method_not_allowed" });
      }
      const header = request.headers["x-semaphore-secret"];
      const candidate = Array.isArray(header) ? header[0] : header;
      if (!isAuthorized(candidate, secret)) return json(response, 401, { error: "unauthorized" });
      const payload = await readJson(request);
      const stored = await storeCookiePayload(DATA_DIR, payload);
      return json(response, 202, { ok: true, domain: stored.domain, cookieCount: stored.cookies.length });
    }

    if (pathname === "/mcp") {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      await handleMcpRequest(request, response, body);
      return;
    }

    json(response, 404, { error: "not_found" });
  } catch (error: unknown) {
    console.error("[semaphore] request failed", error);
    if (!response.headersSent) json(response, 400, { error: "bad_request" });
    else response.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[semaphore] listening on http://${HOST}:${PORT}`);
});
