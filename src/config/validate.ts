/**
 * Server-authoritative validation against the EMITTED schema (one artifact).
 */

import type { RuntimeDescriptor } from "../discovery/detect.js";
import type { ConfigCheckCode } from "./profile.js";
import { ConfigCheckError, ProfileError, checkAgainstProfile } from "./profile.js";
import { buildFormSchema } from "./schema.js";

export type ValidationError =
  | { readonly code: "schema_stale"; readonly snapshotId: string }
  | { readonly code: ConfigCheckCode; readonly field?: string }
  | { readonly code: "out_of_profile"; readonly keyword: string };

export class ConfigError extends Error {
  readonly detail: ValidationError;
  constructor(detail: ValidationError) {
    super(formatDetail(detail));
    this.name = "ConfigError";
    this.detail = detail;
  }
}

function formatDetail(detail: ValidationError): string {
  if (detail.code === "schema_stale") {
    return `schema_stale: ${detail.snapshotId}`;
  }
  if (detail.code === "out_of_profile") {
    return `out_of_profile: ${detail.keyword}`;
  }
  if (detail.field !== undefined) {
    return `${detail.code}: ${detail.field}`;
  }
  return detail.code;
}

/** Accepted create-agent body after validation (option dims are top-level). */
export interface RuntimeConfig {
  readonly runtime: string;
  readonly model: string;
  readonly auth: {
    readonly mode: "ambient" | "explicit_key" | "delegated" | "gateway";
    readonly credential?: { readonly ref: string };
    readonly provider?: string;
  };
  readonly env?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: string;
  readonly fastMode?: boolean;
}

export interface ValidateConfigInput {
  readonly raw: unknown;
  readonly descs: readonly RuntimeDescriptor[];
  readonly submittedSnapshotId: string;
  readonly currentSnapshotId: string;
}

function asRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isAuthMode(
  mode: unknown,
): mode is "ambient" | "explicit_key" | "delegated" | "gateway" {
  return (
    mode === "ambient" ||
    mode === "explicit_key" ||
    mode === "delegated" ||
    mode === "gateway"
  );
}

function buildAuth(
  auth: Record<string, unknown>,
  mode: "ambient" | "explicit_key" | "delegated" | "gateway",
): RuntimeConfig["auth"] {
  if (mode === "ambient") {
    return { mode };
  }
  const { credential, provider } = auth;
  if (!asRecord(credential)) {
    throw new ConfigError({ code: "malformed", field: "auth.credential" });
  }
  const { ref } = credential;
  if (typeof ref !== "string") {
    throw new ConfigError({ code: "malformed", field: "auth.credential.ref" });
  }
  if (typeof provider === "string") {
    return { mode, credential: { ref }, provider };
  }
  return { mode, credential: { ref } };
}

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function toRuntimeConfig(accepted: Record<string, unknown>): RuntimeConfig {
  const { runtime, model, auth, reasoningEffort, fastMode, env } = accepted;
  if (typeof runtime !== "string" || typeof model !== "string" || !asRecord(auth)) {
    throw new ConfigError({ code: "malformed" });
  }
  const { mode } = auth;
  if (!isAuthMode(mode)) {
    throw new ConfigError({ code: "malformed", field: "auth.mode" });
  }
  return {
    runtime,
    model,
    auth: buildAuth(auth, mode),
    ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(asRecord(env) ? { env: stringifyEnv(env) } : {}),
  };
}

function rethrowCheckError(error: unknown): never {
  if (error instanceof ProfileError) {
    throw new ConfigError({ code: "out_of_profile", keyword: error.keyword });
  }
  if (error instanceof ConfigCheckError) {
    if (error.field !== undefined) {
      throw new ConfigError({ code: error.code, field: error.field });
    }
    throw new ConfigError({ code: error.code });
  }
  throw error;
}

/**
 * Validate a create-agent submission against the schema rebuilt from current descriptors.
 * Snapshot mismatch is checked first and is its own closed code.
 */
export function validateConfig(input: ValidateConfigInput): RuntimeConfig {
  const { raw, descs, submittedSnapshotId, currentSnapshotId } = input;
  if (submittedSnapshotId !== currentSnapshotId) {
    throw new ConfigError({ code: "schema_stale", snapshotId: currentSnapshotId });
  }
  if (!asRecord(raw)) {
    throw new ConfigError({ code: "malformed" });
  }
  const { schema } = buildFormSchema(descs);
  try {
    return toRuntimeConfig(checkAgainstProfile(schema, raw));
  } catch (error) {
    return rethrowCheckError(error);
  }
}
