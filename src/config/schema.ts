/**
 * Server: bake one conditional JSON Schema from RuntimeDescriptor[].
 * Clients import nothing from oar — they render this artifact over the wire.
 */

import type { DetectFailure, RuntimeDescriptor } from "../discovery/detect.js";
import { modelBranch } from "./model.js";
import type { JsonSchema } from "./profile.js";
import { assertInProfile } from "./profile.js";

export interface UnknownDimensionNote {
  readonly runtime: string;
  readonly model: string;
  readonly dimensions: readonly string[];
}

export interface FormSchemaResult {
  readonly schema: JsonSchema;
  /** Detected but not offerable — UI may grey out; must NOT enter runtime enum. */
  readonly unavailable: readonly { readonly runtime: string; readonly failure: DetectFailure }[];
  /** Snapshot id echoed on submit; staleness is its own error code. */
  readonly snapshotId: string;
  /** Host-local: unknown support dimensions skipped due to version skew (§11). */
  readonly unknownDimensions?: readonly UnknownDimensionNote[];
}

function partitionDescriptors(descs: readonly RuntimeDescriptor[]): {
  offerable: readonly RuntimeDescriptor[];
  unavailable: readonly { runtime: string; failure: DetectFailure }[];
} {
  const offerable = descs.filter((d) => d.models.length > 0 && d.failure === undefined);
  const unavailable = descs
    .filter((d) => d.models.length === 0 || d.failure !== undefined)
    .map((d) => ({
      runtime: d.runtime,
      failure: d.failure ?? ("models_unavailable" as const),
    }));
  return { offerable, unavailable };
}

function modelAllOf(
  d: RuntimeDescriptor,
  unknownLog: UnknownDimensionNote[],
): readonly { if: JsonSchema; then: JsonSchema }[] {
  return d.models.map((m) => {
    const b = modelBranch(m.support);
    if (b.unknownDimensions.length > 0) {
      unknownLog.push({
        runtime: d.runtime,
        model: m.id,
        dimensions: b.unknownDimensions,
      });
    }
    const thenBody: JsonSchema = {
      properties: b.properties,
      ...(b.required.length > 0 ? { required: b.required } : {}),
    };
    return {
      if: { properties: { model: { const: m.id } }, required: ["model"] },
      then: thenBody,
    };
  });
}

function runtimeAllOf(
  offerable: readonly RuntimeDescriptor[],
  unknownLog: UnknownDimensionNote[],
): readonly { if: JsonSchema; then: JsonSchema }[] {
  return offerable.map((d) => ({
    if: { properties: { runtime: { const: d.runtime } }, required: ["runtime"] },
    then: {
      properties: {
        model: { type: "string", enum: d.models.map((m) => m.id) },
      },
      required: ["model"],
      allOf: modelAllOf(d, unknownLog),
    },
  }));
}

export function buildFormSchema(descs: readonly RuntimeDescriptor[]): FormSchemaResult {
  const { offerable, unavailable } = partitionDescriptors(descs);
  const unknownLog: UnknownDimensionNote[] = [];

  const schema: JsonSchema = {
    type: "object",
    required: ["runtime", "model", "auth"],
    properties: {
      runtime: { type: "string", enum: offerable.map((d) => d.runtime) },
      auth: authSubschema(),
      env: { type: "object", additionalProperties: { type: "string" } },
    },
    allOf: runtimeAllOf(offerable, unknownLog),
  };

  assertInProfile(schema);

  if (unknownLog.length > 0) {
    return {
      schema,
      unavailable,
      snapshotId: snapshotIdOf(descs),
      unknownDimensions: unknownLog,
    };
  }
  return {
    schema,
    unavailable,
    snapshotId: snapshotIdOf(descs),
  };
}

/** Auth wire shape from existing AuthMode + CredentialRef — field name `credential` not `ref`. */
export function authSubschema(): JsonSchema {
  return {
    type: "object",
    required: ["mode"],
    properties: {
      mode: {
        type: "string",
        enum: ["ambient", "explicit_key", "delegated", "gateway"],
      },
      provider: { type: "string" },
    },
    allOf: [
      {
        if: { properties: { mode: { const: "ambient" } }, required: ["mode"] },
        then: { properties: { credential: false } },
      },
      {
        if: {
          properties: {
            mode: { enum: ["explicit_key", "delegated", "gateway"] },
          },
          required: ["mode"],
        },
        then: {
          required: ["credential"],
          properties: {
            credential: {
              type: "object",
              required: ["ref"],
              properties: { ref: { type: "string" } },
            },
          },
        },
      },
    ],
  };
}

/** Stable snapshot id from descriptor content (no crypto dependency). */
export function snapshotIdOf(descs: readonly RuntimeDescriptor[]): string {
  const payload = JSON.stringify(
    descs.map((d) => ({
      runtime: d.runtime,
      version: d.version,
      failure: d.failure ?? null,
      models: d.models.map((m) => ({ id: m.id, support: m.support })),
    })),
  );
  let h = 0x81_1C_9D_C5;
  for (let i = 0; i < payload.length; i++) {
    const cp = payload.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    h ^= cp;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

