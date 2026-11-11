import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onTestFinished } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { createCursorRuntime, type CursorRuntime, type CursorSdk } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { Agent, Cursor, FileCredentialStore } from "./fake-cursor-sdk-module.mjs";

/** The fake SDK module a cursor child imports (fake-cursor-sdk-module.mjs). */
export const FAKE_SDK_MODULE = new URL("fake-cursor-sdk-module.mjs", import.meta.url).href;
export const bundled = { kind: "available", via: "bundled" } as const;

export type CursorMode = "in_process" | "subprocess";

async function fakeSdk(): Promise<CursorSdk> {
  await Promise.resolve();
  return { Agent, Cursor, FileCredentialStore };
}

/** Cursor over the fake module: loaded in this process, or by a child per session and call. */
export function fakeCursorRuntime(mode: CursorMode, envBase: "inherit" | "clean" = "inherit"): CursorRuntime {
  return mode === "subprocess"
    ? createCursorRuntime({ execution: "subprocess", sdkModule: FAKE_SDK_MODULE, envBase })
    : createCursorRuntime({ sdk: fakeSdk });
}

/** A shell command running this Node, printing the names of every variable it sees, sorted, as JSON. */
export function printEnvironmentNames(): string {
  return `"${process.execPath}" -e "console.log(JSON.stringify(Object.keys(process.env).sort()))"`;
}

/** Wait, polling, until `done()` holds or `ms` passed. */
export async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling.
    await delay(20);
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The `{child, grandchild}` pids a `spawn:<file>` run wrote. */
export function reportedPids(file: string): { readonly child: number; readonly grandchild: number } {
  const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const record = asRecord(parsed);
  if (typeof record?.child !== "number" || typeof record.grandchild !== "number") {
    throw new TypeError(`no cursor child pids in ${file}`);
  }
  return { child: record.child, grandchild: record.grandchild };
}

/** A fresh directory, removed when the test ends. */
export function tempDirectory(): string {
  const made = mkdtempSync(path.join(tmpdir(), "oar-cursor-child-"));
  const dir = realpathSync(made);
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** A shell command running this Node, printing the named variables as a JSON array (null when unset). */
export function printEnvironment(names: readonly string[]): string {
  const values = names.map((name) => `process.env.${name}||null`).join(",");
  return `"${process.execPath}" -e "console.log(JSON.stringify([${values}]))"`;
}

/** The `result` of the session's last run, as cursor reported it. */
export function lastResult(session: Session): unknown {
  const frames = session.records().flatMap((record) => (record.kind === "frame" && record.body.type === "cursor/run_result" ? [record.body.native] : []));
  return asRecord(frames.at(-1))?.result;
}

/** The root responses of a kind, in order. */
export function responsesOf(session: Session, kind: string): unknown[] {
  return session.records().flatMap((record) => (record.kind === "response" && record.body.kind === kind ? [record.body] : []));
}
