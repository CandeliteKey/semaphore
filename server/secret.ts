import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

const SECRET_FILE = "secret";

export async function loadOrCreateSecret(dataDir: string): Promise<{ secret: string; created: boolean }> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = path.join(dataDir, SECRET_FILE);

  try {
    const secret = (await readFile(secretPath, "utf8")).trim();
    if (secret.length === 0) throw new Error("secret file is empty");
    return { secret, created: false };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32).toString("base64url");
  try {
    const file = await open(secretPath, "wx", 0o600);
    await file.writeFile(`${secret}\n`, "utf8");
    await file.close();
    return { secret, created: true };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return { secret: (await readFile(secretPath, "utf8")).trim(), created: false };
  }
}
