import { randomBytes } from "node:crypto";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import type { OwnQueryProcess } from "../../shared/executable/query.js";
import { nativeRows } from "../../shared/inventory.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { serveEnvironment } from "./provider-auth-server.js";

type Catalog = "models" | "skills";

async function endpoint(child: LineProcess, catalog: Catalog, signal: AbortSignal): Promise<string> {
  const ready = Promise.withResolvers<string>();
  signal.addEventListener("abort", () => { ready.reject(new Error("OpenCode discovery stopped")); }, { once: true });
  child.onExit(code => { ready.reject(new Error(`OpenCode discovery exited (code ${String(code)})`)); });
  child.onLine((line) => {
    const url = catalog === "models" ? asRecord(parseJson(line))?.url : /^server listening on (\S+)$/u.exec(line)?.[1];
    if (typeof url !== "string") { return; }
    const match = /^http:\/\/127\.0\.0\.1:([0-9]+)\/?$/u.exec(url);
    const port = Number(match?.[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) { ready.resolve(`http://127.0.0.1:${String(port)}`); }
  });
  const value = await ready.promise;
  return value;
}

async function query(origin: string, password: string, cwd: string, signal: AbortSignal, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${origin}${path}`, {
    signal, redirect: "error", headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(cwd),
    },
  });
  if (!response.ok) { throw new Error(`OpenCode discovery ${path} failed (HTTP ${String(response.status)})`); }
  const envelope = asRecord(parseJson(await response.text()));
  return nativeRows(envelope?.data);
}

/** Start a private foreground listener tied to the owning query's deadline and cleanup. */
export async function openDiscoveryServer(command: string, cwd: string, env: NodeJS.ProcessEnv, catalog: Catalog, signal: AbortSignal, own: OwnQueryProcess) {
  const password = randomBytes(24).toString("base64url");
  // The native models CLI's standalone server ends when the host's stdin pipe closes.
  const args = ["serve", ...(catalog === "models" ? ["--stdio"] : []), "--hostname", "127.0.0.1", "--port", "0"];
  const childEnv = serveEnvironment(env, password, catalog === "models" ? "inherit" : "disable");
  const child = own(spawnLineProcess(command, args, {
    cwd, env: childEnv, killTree: true, inheritStderr: false,
    ...(catalog === "models" ? { shutdown: "stdin" } : {}),
  }));
  const [, origin] = await Promise.all([child.spawned, endpoint(child, catalog, signal)]);
  return async (path: string): Promise<JsonRecord[]> => {
    const rows = await query(origin, password, cwd, signal, path);
    return rows;
  };
}
