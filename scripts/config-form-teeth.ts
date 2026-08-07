/**
 * Config-form acceptance teeth (v7 §10). Must go RED before green is believed.
 * Run: npx --yes tsx drydock/probes/config-form-teeth.ts
 */
import { detectAll } from "../src/discovery/detect.js";
import type { RuntimeDriver } from "../src/backend/trait.js";
import type { Declaration } from "../src/backend/trait.js";
import type { ModelConfigSupport, ModelInfo } from "../src/config/model.js";
import { modelBranch, CODEX_CONFIG } from "../src/config/model.js";
import { buildFormSchema, snapshotIdOf } from "../src/config/schema.js";
import { validateConfig, ConfigError } from "../src/config/validate.js";
import {
  checkAgainstProfile,
  profileViolations,
  type JsonSchema,
} from "../src/config/profile.js";
import type { LaunchSpec } from "../src/backend/process/lifecycle.js";
import type { RuntimeEvent } from "../src/events/event.js";

let failed = 0;
function ok(name: string) {
  console.log(`  PASS  ${name}`);
}
function bad(name: string, err: unknown) {
  failed++;
  console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err);
}

function mockDriver(
  id: string,
  opts: {
    detect?: () => Promise<{ version: string } | null>;
    models?: () => Promise<readonly ModelInfo[]>;
  },
): RuntimeDriver {
  return {
    id,
    detect: opts.detect ?? (async () => ({ version: "1.0.0" })),
    models:
      opts.models ??
      (async () =>
        Object.entries(CODEX_CONFIG).map(([mid, support]) => ({ id: mid, support }))),
    describe: async (): Promise<Declaration> => ({
      capabilities: {
        steer: false,
        interrupt: false,
        resume: false,
        interceptToolCalls: false,
      },
      config: { options: [], unsupported: [] },
    }),
    plan: (): LaunchSpec => ({ command: id, args: [], env: {} }),
    readiness: { kind: "process_spawned" },
    shutdown: { graceMs: 1000, onGraceExpiry: "immediate" },
    normalise: (_raw: unknown): readonly RuntimeEvent[] => [],
  };
}

async function main() {
  console.log("config-form teeth");

  // 2 empty-enum / unavailable
  try {
    const descs = await detectAll([
      mockDriver("codex", {}),
      mockDriver("broken", {
        detect: async () => ({ version: "0.1" }),
        models: async () => {
          throw new Error("provider down");
        },
      }),
    ]);
    const { schema, unavailable } = buildFormSchema(descs);
    const runtimeEnum =
      schema !== false && schema.properties && schema.properties.runtime !== false
        ? (schema.properties.runtime as { enum?: string[] }).enum
        : undefined;
    if (!runtimeEnum?.includes("codex")) throw new Error("codex missing from enum");
    if (runtimeEnum?.includes("broken")) throw new Error("broken must not be in enum");
    if (!unavailable.some((u) => u.runtime === "broken" && u.failure === "models_unavailable")) {
      throw new Error("broken not in unavailable");
    }
    ok("2 empty-enum + unavailable");
  } catch (e) {
    bad("2 empty-enum + unavailable", e);
  }

  // 3+4 detect throw isolation + detect_failed ≠ absent
  try {
    const descs = await detectAll([
      mockDriver("healthy", {}),
      mockDriver("boom", {
        detect: async () => {
          throw new Error("segfault");
        },
      }),
      mockDriver("absent", { detect: async () => null }),
    ]);
    const ids = descs.map((d) => d.runtime).sort();
    if (!ids.includes("healthy")) throw new Error("healthy lost");
    if (!ids.includes("boom")) throw new Error("boom should surface as detect_failed");
    if (ids.includes("absent")) throw new Error("absent should be omitted");
    const boom = descs.find((d) => d.runtime === "boom");
    if (boom?.failure !== "detect_failed") throw new Error(`want detect_failed got ${boom?.failure}`);
    ok("3+4 detect isolation + detect_failed≠absent");
  } catch (e) {
    bad("3+4 detect isolation", e);
  }

  // 5 validate garbage
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: Object.entries(CODEX_CONFIG).map(([id, support]) => ({ id, support })),
      },
    ];
    const snap = snapshotIdOf(descs);
    const cases: unknown[] = [null, "x", { runtime: "codex" }, { runtime: "codex", model: "gpt-5.6", auth: null }];
    for (const raw of cases) {
      try {
        validateConfig({ raw, descs, submittedSnapshotId: snap, currentSnapshotId: snap });
        throw new Error(`expected throw for ${JSON.stringify(raw)}`);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
      }
    }
    // wrong type for bool
    try {
      validateConfig({
        raw: {
          runtime: "codex",
          model: "gpt-5.6",
          auth: { mode: "ambient" },
          reasoningEffort: "high",
          fastMode: "yes",
        },
        descs,
        submittedSnapshotId: snap,
        currentSnapshotId: snap,
      });
      throw new Error("expected fastMode type fail");
    } catch (e) {
      if (!(e instanceof ConfigError) || e.detail.code !== "value_not_allowed") throw e;
    }
    ok("5 validate rejects garbage");
  } catch (e) {
    bad("5 validate garbage", e);
  }

  // 6 stale ≠ invalid
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: [{ id: "gpt-5.6", support: CODEX_CONFIG["gpt-5.6"]! }],
      },
    ];
    const body = {
      runtime: "codex",
      model: "gpt-5.6",
      auth: { mode: "ambient" },
      reasoningEffort: "high",
      fastMode: true,
    };
    try {
      validateConfig({ raw: body, descs, submittedSnapshotId: "old", currentSnapshotId: "new" });
      throw new Error("expected stale");
    } catch (e) {
      if (!(e instanceof ConfigError) || e.detail.code !== "schema_stale") throw e;
    }
    // even if model gone, stale wins first
    try {
      validateConfig({
        raw: { ...body, model: "gone" },
        descs,
        submittedSnapshotId: "old",
        currentSnapshotId: "new",
      });
      throw new Error("expected stale");
    } catch (e) {
      if (!(e instanceof ConfigError) || e.detail.code !== "schema_stale") throw e;
    }
    ok("6 stale ≠ invalid");
  } catch (e) {
    bad("6 stale", e);
  }

  // 7 conditional-branch isolation
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: [{ id: "gpt-5.6", support: CODEX_CONFIG["gpt-5.6"]! }],
      },
      {
        runtime: "pi",
        version: "1",
        models: [
          {
            id: "deepseek",
            support: { reasoningEffort: null, fastMode: false } satisfies ModelConfigSupport,
          },
        ],
      },
    ];
    const { schema } = buildFormSchema(descs);
    const { effectiveSchema } = await import("../src/config/profile.js");
    const eff = effectiveSchema(schema, {});
    if ("model" in eff.properties) {
      throw new Error("model should not appear without runtime selected");
    }
    if ("reasoningEffort" in eff.properties) {
      throw new Error("options should not appear without model selected");
    }
    const withRuntime = effectiveSchema(schema, { runtime: "codex" });
    if (!("model" in withRuntime.properties)) {
      throw new Error("model should appear once runtime selected");
    }
    ok("7 conditional-branch isolation");
  } catch (e) {
    bad("7 conditional isolation", e);
  }

  // happy path validate
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: Object.entries(CODEX_CONFIG).map(([id, support]) => ({ id, support })),
      },
    ];
    const snap = snapshotIdOf(descs);
    const accepted = validateConfig({
      raw: {
        runtime: "codex",
        model: "gpt-5.6",
        auth: { mode: "ambient" },
        reasoningEffort: "high",
        fastMode: true,
      },
      descs,
      submittedSnapshotId: snap,
      currentSnapshotId: snap,
    });
    if (accepted.model !== "gpt-5.6") throw new Error("bad accept");
    // gpt-4.1 + reasoningEffort → unsupported
    try {
      validateConfig({
        raw: {
          runtime: "codex",
          model: "gpt-4.1",
          auth: { mode: "ambient" },
          reasoningEffort: "low",
        },
        descs,
        submittedSnapshotId: snap,
        currentSnapshotId: snap,
      });
      throw new Error("expected unsupported");
    } catch (e) {
      if (!(e instanceof ConfigError) || e.detail.code !== "unsupported_option") throw e;
    }
    ok("happy path + unsupported_option");
  } catch (e) {
    bad("happy path", e);
  }

  // 8b fail-closed out_of_profile
  try {
    const badSchema = {
      type: "object",
      properties: { x: { type: "string" } },
      oneOf: [{ type: "string" }],
    } as unknown as JsonSchema;
    const v = profileViolations(badSchema);
    if (!v.some((x) => x.keyword === "oneOf")) throw new Error("oneOf not flagged");
    try {
      checkAgainstProfile(badSchema, { x: "a" });
      throw new Error("expected out_of_profile");
    } catch (e) {
      if (!(e instanceof Error) || !String(e.message).includes("out_of_profile")) throw e;
    }
    ok("8b fail-closed out_of_profile");
  } catch (e) {
    bad("8b fail-closed", e);
  }

  // 8d unknown dimension does not throw
  try {
    const raw = {
      reasoningEffort: ["low"] as const,
      fastMode: true,
      contextWindow: ["272k", "1m"],
    };
    const b2 = modelBranch(raw as unknown as ModelConfigSupport);
    if (!b2.unknownDimensions.includes("contextWindow")) {
      throw new Error(`want contextWindow unknown, got ${b2.unknownDimensions.join(",")}`);
    }
    if ("contextWindow" in b2.properties) throw new Error("unknown dim must not emit");
    ok("8d unknown dimension skip");
  } catch (e) {
    bad("8d unknown dim", e);
  }

  // 9 emitter profile
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: [{ id: "gpt-5.6", support: CODEX_CONFIG["gpt-5.6"]! }],
      },
    ];
    const { schema } = buildFormSchema(descs);
    const v = profileViolations(schema);
    if (v.length > 0) throw new Error(`profile violations: ${JSON.stringify(v)}`);
    ok("9 emitted schema in profile");
  } catch (e) {
    bad("9 emitter profile", e);
  }

  // ambient + credential forbidden
  try {
    const descs = [
      {
        runtime: "codex",
        version: "1",
        models: [{ id: "gpt-5.6", support: CODEX_CONFIG["gpt-5.6"]! }],
      },
    ];
    const snap = snapshotIdOf(descs);
    try {
      validateConfig({
        raw: {
          runtime: "codex",
          model: "gpt-5.6",
          auth: { mode: "ambient", credential: { ref: "x" } },
          reasoningEffort: "high",
          fastMode: true,
        },
        descs,
        submittedSnapshotId: snap,
        currentSnapshotId: snap,
      });
      throw new Error("ambient+credential should fail");
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
    }
    ok("auth ambient forbids credential");
  } catch (e) {
    bad("auth ambient", e);
  }

  if (failed > 0) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall teeth green");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
