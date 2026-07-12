import path from "node:path";

export const PORT = 8931;
export const HOST = process.env["SEMAPHORE_HOST"] ?? "127.0.0.1";
export const DATA_DIR = process.env["SEMAPHORE_DATA_DIR"] ?? path.resolve("data");
