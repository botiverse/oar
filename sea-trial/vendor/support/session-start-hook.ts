import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportedProcess, gone } from "../../../tests/fixtures/process-tree.js";
import { asRecord, type JsonRecord } from "../../../packages/oar/src/shared/json.js";

const script = fileURLToPath(new URL("../../../tests/fixtures/session-start-hook.mjs", import.meta.url));

export function sessionStartHook(directory: string, delayMs: number): { readonly command: string; readonly file: string } {
  const file = path.join(directory, "hook.jsonl");
  // Forward slashes also work in Node's Windows paths, including under Git Bash.
  const command = [process.execPath, script, file].map((value) => JSON.stringify(value.replaceAll("\\", "/"))).join(" ");
  return { command: `${command} ${String(delayMs)}`, file };
}

export async function hookMarks(file: string): Promise<readonly JsonRecord[]> {
  const content = await readFile(file, "utf8");
  return content.trim().split("\n").map((line) => asRecord(JSON.parse(line)) ?? {});
}

export async function expectHookExited(mark: unknown): Promise<void> {
  const processId = reportedProcess(mark);
  assert.ok(await gone(processId, 10_000), `Hook process ${processId.pid} is still running`);
}
