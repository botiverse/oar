import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(isObject(value), "Expected a JSON object from the synthetic fixture.");
  return value;
}

export function readObject(file: string): Record<string, unknown> | null {
  try {
    return parseObject(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (isObject(error) && error.code === "ENOENT")) { return null; }
    throw error;
  }
}

export function numberField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  assert.equal(typeof value, "number", `Expected a numeric ${key}: ${JSON.stringify(object)}`);
  assert.ok(typeof value === "number");
  return value;
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Polling observes changes between samples.
    await delay(25);
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}
