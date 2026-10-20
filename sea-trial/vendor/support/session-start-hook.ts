import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (asRecord(error)?.code === "ESRCH") { return false; }
    throw error;
  }
}
