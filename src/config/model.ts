/**
 * Model support — the single source for create-agent config.
 *
 * ⚠️ Field set of ModelConfigSupport is PROVISIONAL pending xxchan 甲/乙/丙
 * (closed struct growth, labels, grouping). Do not expand dimensions until settled.
 * Shape rule is settled: supported ⇒ required; absence is always illegal.
 */

import type { JsonSchema } from "./profile.js";

/**
 * What a model SUPPORTS per dimension. CLOSED struct: a dimension is never absent.
 * - enum dim: `null` = unsupported; non-null array = supported (and required)
 * - bool dim: `false` = unsupported; `true` = supported (and required)
 */
export interface ModelConfigSupport {
  readonly reasoningEffort: readonly string[] | null;
  readonly fastMode: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly support: ModelConfigSupport;
}

/** Selected values — mechanically derived from Support. */
export type ModelConfig = {
  readonly [K in keyof ModelConfigSupport]?: ModelConfigSupport[K] extends readonly string[] | null
    ? string
    : ModelConfigSupport[K] extends boolean
      ? boolean
      : never;
};

/** Compile-time map of every declared dimension — adding a key to Support fails this assign. */
const DECLARED_DIMENSIONS: { readonly [K in keyof ModelConfigSupport]: true } = {
  reasoningEffort: true,
  fastMode: true,
};

function assertNever(x: never): never {
  throw new Error(`unhandled ModelConfigSupport dimension: ${String(x)}`);
}

export interface ModelBranch {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  /** Runtime-only: keys present on the object but not in this oar version's Support. */
  readonly unknownDimensions: readonly string[];
}

interface BranchAcc {
  properties: Record<string, JsonSchema>;
  required: string[];
  unknownDimensions: string[];
}

function isDeclaredKey(key: string): key is keyof ModelConfigSupport {
  return Object.hasOwn(DECLARED_DIMENSIONS, key);
}

function emitReasoningEffort(acc: BranchAcc, values: readonly string[] | null): void {
  if (values === null) {
    return;
  }
  acc.properties.reasoningEffort = { type: "string", enum: [...values] };
  acc.required.push("reasoningEffort");
}

function emitFastMode(acc: BranchAcc, supported: boolean): void {
  if (!supported) {
    return;
  }
  acc.properties.fastMode = { type: "boolean" };
  acc.required.push("fastMode");
}

function emitKnown(acc: BranchAcc, k: keyof ModelConfigSupport, s: ModelConfigSupport): void {
  switch (k) {
    case "reasoningEffort":
      emitReasoningEffort(acc, s.reasoningEffort);
      return;
    case "fastMode":
      emitFastMode(acc, s.fastMode);
      return;
    default:
      assertNever(k);
  }
}

/**
 * support → schema fragment for one model (the ONE derivation of the rule).
 *
 * Compile time: new Support dimensions make DECLARED_DIMENSIONS / switch fail to typecheck.
 * Run time: unknown keys (version skew from a newer computer) are SKIPPED + recorded — never throw.
 */
export function modelBranch(s: ModelConfigSupport): ModelBranch {
  const acc: BranchAcc = {
    properties: {},
    required: [],
    unknownDimensions: [],
  };

  for (const key of Object.keys(s)) {
    if (isDeclaredKey(key)) {
      emitKnown(acc, key, s);
    } else {
      acc.unknownDimensions.push(key);
    }
  }

  return {
    properties: acc.properties,
    required: acc.required,
    unknownDimensions: acc.unknownDimensions,
  };
}

/**
 * Illustrative codex per-model support. Model LIST is dynamic; SUPPORT is oar knowledge.
 * ⚠️ Provisional dimensions only.
 */
export const CODEX_CONFIG: Readonly<Record<string, ModelConfigSupport>> = {
  "gpt-5.6": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    fastMode: true,
  },
  "gpt-5": { reasoningEffort: ["low", "medium", "high"], fastMode: true },
  "gpt-4.1": { reasoningEffort: null, fastMode: false },
};
