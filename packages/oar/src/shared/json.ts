/** Narrowing helpers for untyped JSON coming from native runtime surfaces. */
export type JsonRecord = Record<string, unknown>;

/** Parse JSON text; undefined (never a legal JSON value) signals invalid JSON. */
export function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
