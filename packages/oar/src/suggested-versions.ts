/** Pure per-runtime suggested minimum versions for latest upstream models. */
import { compareSemver, extractSemver, parseSemver } from "./shared/semver.js";

/** Public raw manifest URL in the OAR repository for out-of-band host refreshes. */
export const SUGGESTED_VERSIONS_URL =
  "https://raw.githubusercontent.com/botiverse/oar/main/packages/oar/assets/suggested-versions.json";

export interface SuggestedVersionEntry {
  readonly version: string;
  readonly reason: string;
  readonly verifiedAt?: string;
  readonly evidence?: string;
}

export interface SuggestedVersionsManifest {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly runtimes: Readonly<Record<string, SuggestedVersionEntry>>;
}

export interface SuggestedVersionAdvice {
  readonly runtime: string;
  readonly installedVersion: string;
  readonly suggestedMinVersion: string;
  readonly reason: string;
}

function freezeEntry(entry: SuggestedVersionEntry): SuggestedVersionEntry {
  return Object.freeze(entry);
}

/** Bundled fallback matching `packages/oar/assets/suggested-versions.json`. */
export const suggestedVersions: SuggestedVersionsManifest = Object.freeze({
  schemaVersion: 1,
  updatedAt: "2026-11-26",
  runtimes: Object.freeze({
    codex: freezeEntry({
      version: "0.166.0",
      reason: "Supports GPT-6.2 models (gpt-6.2-sol, gpt-6.2-astra)",
      verifiedAt: "2026-11-26",
      evidence: "https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json",
    }),
    claude: freezeEntry({
      version: "2.1.321",
      reason: "Supports Claude Fable 5.2 (claude-fable-5-2)",
      verifiedAt: "2026-11-26",
      evidence: "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21321",
    }),
  }),
});

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEntry(value: unknown): SuggestedVersionEntry | null {
  const record = asPlainObject(value);
  if (record === null) {
    return null;
  }
  const version = nonEmptyText(record.version);
  const reason = nonEmptyText(record.reason);
  if (version === undefined || parseSemver(version) === null || reason === undefined) {
    return null;
  }
  const verifiedAt = nonEmptyText(record.verifiedAt);
  const evidence = nonEmptyText(record.evidence);
  return Object.freeze({
    version,
    reason,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function parseRuntimes(value: unknown): Readonly<Record<string, SuggestedVersionEntry>> | null {
  const record = asPlainObject(value);
  if (record === null) {
    return null;
  }
  const entries: [string, SuggestedVersionEntry][] = [];
  for (const [key, item] of Object.entries(record)) {
    const runtimeId = nonEmptyText(key);
    const entry = parseEntry(item);
    if (runtimeId !== undefined && entry !== null) {
      entries.push([runtimeId, entry]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** Validate a fetched manifest; drops malformed runtime rows and returns null on an invalid document. */
export function parseSuggestedVersions(raw: unknown): SuggestedVersionsManifest | null {
  const root = asPlainObject(raw);
  if (root === null || root.schemaVersion !== 1) {
    return null;
  }
  const updatedAt = nonEmptyText(root.updatedAt);
  const runtimes = parseRuntimes(root.runtimes);
  if (updatedAt === undefined || runtimes === null) {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, updatedAt, runtimes });
}

/** Return upgrade advice when `installedVersion` is readable and strictly below the runtime's suggested floor. */
export function checkSuggestedVersion(
  runtimeId: string,
  installedVersion: string | undefined,
  manifest: SuggestedVersionsManifest = suggestedVersions,
): SuggestedVersionAdvice | null {
  if (!Object.hasOwn(manifest.runtimes, runtimeId)) {
    return null;
  }
  const entry = manifest.runtimes[runtimeId];
  const installed = extractSemver(installedVersion);
  if (entry === undefined || installed === undefined) {
    return null;
  }
  const order = compareSemver(installed, entry.version);
  return order !== null && order < 0
    ? { runtime: runtimeId, installedVersion: installed, suggestedMinVersion: entry.version, reason: entry.reason }
    : null;
}
