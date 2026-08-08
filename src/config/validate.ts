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

/** Accepted create-agent body after validation. Options are top-level fields. */
export type RuntimeConfig = {
  readonly runtime: string;
  readonly model: string;
  readonly provider?: string;
  readonly auth: {
    readonly mode: "ambient" | "explicit_key" | "delegated" | "gateway";
    readonly credential?: { readonly ref: string };
  };
  readonly env?: Readonly<Record<string, string>>;
} & Readonly<Record<string, string | boolean | number | undefined | object>>;

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
    const accepted = checkAgainstProfile(schema, raw);
    const { runtime, model, auth } = accepted;
    if (typeof runtime !== "string" || typeof model !== "string" || !asRecord(auth)) {
      throw new ConfigError({ code: "malformed" });
    }
    if (!isAuthMode(auth.mode)) {
      throw new ConfigError({ code: "malformed", field: "auth.mode" });
    }
    return accepted as RuntimeConfig;
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new ConfigError({ code: "out_of_profile", keyword: error.keyword });
    }
    if (error instanceof ConfigCheckError) {
      if (error.field !== undefined) {
        throw new ConfigError({ code: error.code, field: error.field });
      }
      throw new ConfigError({ code: error.code });
    }
    if (error instanceof ConfigError) throw error;
    throw error;
  }
}
