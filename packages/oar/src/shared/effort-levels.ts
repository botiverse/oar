import { asRecord } from "./json.js";

/**
 * Reasoning-effort menu as plain level names. Runtimes disagree on the entry
 * shape: codex ships `{effort, description}` objects, claude ships strings,
 * grok's ACP extension may ship either. Returns `undefined` when the runtime
 * exposes no menu at all, so callers can omit the field rather than emit `[]`.
 */
export function effortLevelsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: unknown[] = value;
  const levels: string[] = [];
  for (const entry of entries) {
    const level = typeof entry === "string" ? entry : effortName(asRecord(entry));
    if (level !== undefined) {
      levels.push(level);
    }
  }
  return levels;
}

function effortName(record: Record<string, unknown> | null): string | undefined {
  const candidate = record?.effort ?? record?.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** A single effort name, or `undefined` when absent or not a non-empty string. */
export function effortLevelOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return effortName(asRecord(value));
}
