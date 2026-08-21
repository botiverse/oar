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

/** Narrow an epoch timestamp in seconds or milliseconds to an ISO-8601 instant. */
export function asEpochInstant(value: unknown): string | null {
  const raw = asNumber(value);
  if (raw === null) {
    return null;
  }
  const instant = new Date(raw >= 1_000_000_000_000 ? raw : raw * 1000);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}
