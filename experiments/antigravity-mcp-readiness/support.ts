/* oxlint-disable eslint/no-await-in-loop -- Copy the small native evidence set in order. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import type { RawProviderRequest } from "../../sea-trial/harness/aimock.js";

export interface Mark extends JsonRecord { readonly at: number; readonly event: string }
export interface Wire { readonly at: number; readonly direction: string; readonly message: unknown }

/** Only declarations count: a prompt or result mentioning a tool is not a catalog. */
export function toolNames(value: unknown, location: readonly string[] = []): string[] {
  if (Array.isArray(value)) { return value.flatMap((entry, index) => toolNames(entry, [...location, String(index)])); }
  const object = asRecord(value);
  if (object === null) { return []; }
  return Object.entries(object).flatMap(([key, entry]) => {
    const names = toolNames(entry, [...location, key]);
    if (key === "name" && typeof entry === "string" && location.some((part) => part === "functionDeclarations" || part === "function_declarations")) {
      names.unshift(entry);
    }
    return names;
  });
}

/** These are private raw logs from fresh synthetic homes, not a credential sanitizer. */
export async function copyLogs(geminiHome: string, dir: string): Promise<void> {
  const logDir = path.join(geminiHome, "antigravity-cli/log");
  for (const file of await readdir(logDir).catch(() => [])) {
    if (file.endsWith(".log")) { await writeFile(path.join(dir, `native-${file}`), await readFile(path.join(logDir, file)), { mode: 0o600 }); }
  }
}

interface Observations {
  readonly name: string;
  readonly version: string;
  readonly delayMs: number;
  readonly opened: JsonRecord;
  readonly initialized: JsonRecord;
  readonly wire: readonly Wire[];
  readonly marks: readonly Mark[];
  readonly raw: readonly RawProviderRequest[];
  readonly echoes: readonly string[];
  readonly failure: string | undefined;
}

export function summarize(run: Observations): JsonRecord {
  const raw = run.raw.map((request) => ({
    tools: toolNames(request.body),
    first: JSON.stringify(request.body).includes("READINESS_FIRST"),
    second: JSON.stringify(request.body).includes("READINESS_SECOND"),
    unknownTool: JSON.stringify(request.body).includes("unknown tool:"),
  }));
  const notifications = run.wire.flatMap((entry) => {
    const message = asRecord(entry.message);
    if (entry.direction !== "in" || typeof message?.method !== "string") { return []; }
    const update = asRecord(asRecord(message.params)?.update);
    const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
    return [`${message.method}:${kind}`];
  });
  return {
    name: run.name, version: run.version, platform: process.platform, delayMs: run.delayMs,
    openedKeys: Object.keys(run.opened), initializeCapabilities: run.initialized.agentCapabilities,
    firstTools: raw.find((request) => request.first && request.tools.length > 0)?.tools,
    secondTools: raw.find((request) => request.second && request.tools.length > 0)?.tools,
    echoes: run.echoes.map((echo) => echo.split(" token=")[0] ?? ""),
    unknownTool: raw.some((request) => request.unknownTool), notifications: [...new Set(notifications)],
    marks: run.marks, ...(run.failure === undefined ? {} : { failure: run.failure }),
  };
}
