import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const firefoxCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().min(1),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  expirationDate: z.number().finite().optional(),
  sameSite: z.enum(["no_restriction", "lax", "strict", "unspecified"]).optional()
});

export const cookiePayloadSchema = z.object({
  domain: z.string().min(1),
  userAgent: z.string().min(1).optional(),
  cookies: z.array(firefoxCookieSchema)
});

export type FirefoxCookie = z.infer<typeof firefoxCookieSchema>;
export type CookiePayload = z.infer<typeof cookiePayloadSchema>;

export interface StoredDomain {
  cookies: FirefoxCookie[];
  updatedAt: string;
  userAgent?: string;
}

export interface CookieStore {
  version: 1;
  userAgent?: string;
  domains: Record<string, StoredDomain>;
}

const emptyStore = (): CookieStore => ({ version: 1, domains: {} });
let writeQueue: Promise<void> = Promise.resolve();

export function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase().replace(/^\.+/, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes(":")) {
    throw new Error(`invalid domain: ${domain}`);
  }
  return trimmed;
}

export async function loadCookieStore(dataDir: string): Promise<CookieStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dataDir, "cookies.json"), "utf8"));
    const schema = z.object({
      version: z.literal(1),
      userAgent: z.string().optional(),
      domains: z.record(z.object({
        cookies: z.array(firefoxCookieSchema),
        updatedAt: z.string(),
        userAgent: z.string().optional()
      }))
    });
    return schema.parse(parsed);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function storeCookiePayload(dataDir: string, rawPayload: unknown): Promise<CookiePayload> {
  const payload = cookiePayloadSchema.parse(rawPayload);
  const domain = normalizeDomain(payload.domain);

  const operation = writeQueue.then(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = await loadCookieStore(dataDir);
    const previous = store.domains[domain];
    const userAgent = payload.userAgent ?? previous?.userAgent ?? store.userAgent;
    store.domains[domain] = {
      cookies: payload.cookies,
      updatedAt: new Date().toISOString(),
      ...(userAgent === undefined ? {} : { userAgent })
    };
    if (payload.userAgent !== undefined) store.userAgent = payload.userAgent;

    const destination = path.join(dataDir, "cookies.json");
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  return payload;
}

export function findStoredDomain(store: CookieStore, hostname: string): [string, StoredDomain] | undefined {
  const host = normalizeDomain(hostname);
  return Object.entries(store.domains)
    .filter(([domain]) => host === domain || host.endsWith(`.${domain}`))
    .sort(([a], [b]) => b.length - a.length)[0];
}
