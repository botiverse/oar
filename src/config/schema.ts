/**
 * Server: bake one conditional JSON Schema from RuntimeDescriptor[].
 * Clients import nothing from oar — they render this artifact over the wire.
 */

import type { DetectFailure, RuntimeDescriptor } from "../discovery/detect.js";
import type { ModelInfo, ProviderInfo } from "./model.js";
import { optionsBranch } from "./model.js";
import type { JsonSchema } from "./profile.js";
import { assertInProfile } from "./profile.js";

export interface UnknownOptionNote {
  readonly runtime: string;
  readonly model: string;
  readonly kinds: readonly string[];
}

export interface FormSchemaResult {
  readonly schema: JsonSchema;
  /** Detected but not offerable — UI may grey out; must NOT enter runtime enum. */
  readonly unavailable: readonly { readonly runtime: string; readonly failure: DetectFailure }[];
  /** Snapshot id echoed on submit; staleness is its own error code. */
  readonly snapshotId: string;
  /** Host-local: unknown option kinds skipped due to version skew. */
  readonly unknownOptions?: readonly UnknownOptionNote[];
  /** Per-id labels for UI (not part of JSON Schema profile). */
  readonly labels: Readonly<Record<string, string>>;
}

function isOfferable(d: RuntimeDescriptor): boolean {
  if (d.failure !== undefined) return false;
  if (d.providers && d.providers.length > 0) {
    return d.providers.some((p) => p.models.length > 0);
  }
  return d.models.length > 0;
}

function partitionDescriptors(descs: readonly RuntimeDescriptor[]): {
  offerable: readonly RuntimeDescriptor[];
  unavailable: readonly { runtime: string; failure: DetectFailure }[];
} {
  const offerable = descs.filter(isOfferable);
  const unavailable = descs
    .filter((d) => !isOfferable(d))
    .map((d) => ({
      runtime: d.runtime,
      failure: d.failure ?? ("models_unavailable" as const),
    }));
  return { offerable, unavailable };
}

function modelThen(m: ModelInfo, runtime: string, unknownLog: UnknownOptionNote[]): JsonSchema {
  const b = optionsBranch(m.options);
  if (b.unknownKinds.length > 0) {
    unknownLog.push({ runtime, model: m.id, kinds: b.unknownKinds });
  }
  return {
    properties: b.properties,
    ...(b.required.length > 0 ? { required: b.required } : {}),
  };
}

function modelAllOf(
  models: readonly ModelInfo[],
  runtime: string,
  unknownLog: UnknownOptionNote[],
): readonly { if: JsonSchema; then: JsonSchema }[] {
  return models.map((m) => ({
    if: { properties: { model: { const: m.id } }, required: ["model"] },
    then: modelThen(m, runtime, unknownLog),
  }));
}

function providerAllOf(
  providers: readonly ProviderInfo[],
  runtime: string,
  unknownLog: UnknownOptionNote[],
): readonly { if: JsonSchema; then: JsonSchema }[] {
  return providers.map((p) => ({
    if: { properties: { provider: { const: p.id } }, required: ["provider"] },
    then: {
      properties: {
        model: { type: "string", enum: p.models.map((m) => m.id) },
      },
      required: ["model"],
      allOf: modelAllOf(p.models, runtime, unknownLog),
    },
  }));
}

function runtimeThen(
  d: RuntimeDescriptor,
  unknownLog: UnknownOptionNote[],
): JsonSchema {
  if (d.providers && d.providers.length > 0) {
    return {
      properties: {
        provider: { type: "string", enum: d.providers.map((p) => p.id) },
      },
      required: ["provider"],
      allOf: providerAllOf(d.providers, d.runtime, unknownLog),
    };
  }
  return {
    properties: {
      model: { type: "string", enum: d.models.map((m) => m.id) },
    },
    required: ["model"],
    allOf: modelAllOf(d.models, d.runtime, unknownLog),
  };
}

function runtimeAllOf(
  offerable: readonly RuntimeDescriptor[],
  unknownLog: UnknownOptionNote[],
): readonly { if: JsonSchema; then: JsonSchema }[] {
  return offerable.map((d) => ({
    if: { properties: { runtime: { const: d.runtime } }, required: ["runtime"] },
    then: runtimeThen(d, unknownLog),
  }));
}

function collectLabels(descs: readonly RuntimeDescriptor[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const d of descs) {
    labels[`runtime:${d.runtime}`] = d.label ?? d.runtime;
    for (const m of d.models) {
      labels[`model:${d.runtime}:${m.id}`] = m.label;
      for (const o of m.options) {
        labels[`option:${o.id}`] = o.label;
        if (o.kind === "enum") {
          for (const v of o.values) {
            labels[`choice:${o.id}:${v.id}`] = v.label;
          }
        }
      }
    }
    for (const p of d.providers ?? []) {
      labels[`provider:${d.runtime}:${p.id}`] = p.label;
      for (const m of p.models) {
        labels[`model:${d.runtime}:${p.id}:${m.id}`] = m.label;
        labels[`model:${d.runtime}:${m.id}`] = m.label;
        for (const o of m.options) {
          labels[`option:${o.id}`] = o.label;
          if (o.kind === "enum") {
            for (const v of o.values) {
              labels[`choice:${o.id}:${v.id}`] = v.label;
            }
          }
        }
      }
    }
  }
  return labels;
}

export function buildFormSchema(descs: readonly RuntimeDescriptor[]): FormSchemaResult {
  const { offerable, unavailable } = partitionDescriptors(descs);
  const unknownLog: UnknownOptionNote[] = [];

  const schema: JsonSchema = {
    type: "object",
    required: ["runtime", "auth"],
    properties: {
      runtime: { type: "string", enum: offerable.map((d) => d.runtime) },
      auth: authSubschema(),
      env: { type: "object", additionalProperties: { type: "string" } },
      // provider / model / options appear via allOf
      provider: { type: "string" },
      model: { type: "string" },
    },
    allOf: runtimeAllOf(offerable, unknownLog),
  };

  assertInProfile(schema);

  const base = {
    schema,
    unavailable,
    snapshotId: snapshotIdOf(descs),
    labels: collectLabels(descs),
  };
  if (unknownLog.length > 0) {
    return { ...base, unknownOptions: unknownLog };
  }
  return base;
}

/** Auth wire shape — field name `credential` not nested `ref` alone. */
export function authSubschema(): JsonSchema {
  return {
    type: "object",
    required: ["mode"],
    properties: {
      mode: {
        type: "string",
        enum: ["ambient", "explicit_key", "delegated", "gateway"],
      },
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
      models: d.models.map((m) => ({ id: m.id, options: m.options })),
      providers: (d.providers ?? []).map((p) => ({
        id: p.id,
        models: p.models.map((m) => ({ id: m.id, options: m.options })),
      })),
    })),
  );
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < payload.length; i++) {
    const cp = payload.codePointAt(i);
    if (cp === undefined) break;
    h ^= cp;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
