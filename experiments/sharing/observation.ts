/** Probe-only budgets and evidence. These do not change runtime defaults. */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

export const probeTimeout = (normalMs: number): number => process.platform === "win32" ? normalMs * 3 : normalMs;

export class ProbeTiming {
  readonly waits: JsonRecord[] = [];

  async measure<T>(label: string, limitMs: number | null, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const row: JsonRecord = { label, at: new Date().toISOString(), limitMs };
    this.waits.push(row);
    try { const value = await work(); row.outcome = "completed"; return value; }
    catch (error) { row.outcome = "failed"; row.error = String(error); throw error; }
    finally { row.elapsedMs = performance.now() - started; }
  }

  async wait<T>(pending: Promise<T>, label: string, ms = probeTimeout(30_000)): Promise<T> {
    const value = await this.measure(label, ms, async () => {
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => { timeout.reject(new Error(`Timed out: ${label}`)); }, ms);
      try { return await Promise.race([pending, timeout.promise]); } finally { clearTimeout(timer); }
    });
    return value;
  }

  async until(check: () => boolean | Promise<boolean>, label: string, ms = probeTimeout(30_000)): Promise<void> {
    await this.measure(label, ms, async () => {
      const end = performance.now() + ms;
      // oxlint-disable-next-line no-await-in-loop -- Each poll observes the preceding native state.
      while (!await check()) {
        assert.ok(performance.now() < end, `Timed out: ${label}`);
        // oxlint-disable-next-line no-await-in-loop -- Bounded observation of a native condition.
        await delay(20);
      }
    });
  }
}

export async function prepareFixture<T>(directory: string, report: JsonRecord, create: () => Promise<T>): Promise<T> {
  try { return await create(); }
  catch (error) {
    report.setupError = String(error);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    throw error;
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    const decoded = parseJson(value);
    return decoded === undefined || decoded === value ? [value] : [value, ...strings(decoded)];
  }
  if (Array.isArray(value)) { return value.flatMap((entry: unknown) => strings(entry)); }
  const record = asRecord(value);
  return record === null ? [] : Object.values(record).flatMap((entry) => strings(entry));
}

function canonical(value: string): string {
  const resolved = realpathSync.native(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function cwdEvidence(expected: string, output: unknown): JsonRecord {
  const expectedCanonical = canonical(expected);
  const raw = [...new Set(strings(output).flatMap((text) => [...text.matchAll(/(?:^|\n)CWD_RESULT=(?<cwd>[^\r\n]+)/gu)].map((match) => match.groups?.cwd ?? "")))];
  assert.ok(raw.length > 0, "tool output contains a cwd marker");
  const observed = raw.map((value) => ({ raw: value, canonical: canonical(value) }));
  assert.ok(observed.every((entry) => entry.canonical === expectedCanonical), "tool ran in its own canonical directory");
  return { expectedRaw: expected, expectedCanonical, observed };
}

export function powershellCommand(args: readonly string[]): string {
  return `& ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}`;
}
