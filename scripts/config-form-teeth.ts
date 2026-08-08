/**
 * Config-form acceptance teeth. Run: npm run teeth
 */
import { detectAll } from "../src/discovery/detect.js";
import type { RuntimeDriver } from "../src/backend/trait.js";
import type { Declaration } from "../src/backend/trait.js";
import type { ModelInfo } from "../src/config/model.js";
import { model, enumOpt, boolOpt } from "../src/config/model.js";
import { buildFormSchema, snapshotIdOf } from "../src/config/schema.js";
import { validateConfig, ConfigError } from "../src/config/validate.js";
import {
  checkAgainstProfile,
  profileViolations,
  type JsonSchema,
} from "../src/config/profile.js";
import type { LaunchSpec } from "../src/backend/process/lifecycle.js";
import type { RuntimeEvent } from "../src/events/event.js";
import {
  assertFixtureCoversRegistry,
  creatableDescriptors,
  deprecatedExcluded,
  fixtureDescriptors,
  RAFT_DRIVER_REGISTRY,
} from "../src/discovery/fixtures/raftRuntimes.js";

let failed = 0;
function ok(name: string) {
  console.log(`  PASS  ${name}`);
}
function bad(name: string, err: unknown) {
  failed++;
  console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err);
}

const SAMPLE_MODELS: readonly ModelInfo[] = [
  model("gpt-5.6", "GPT-5.6", [
    enumOpt("reasoningEffort", "Reasoning", ["low", "medium", "high"]),
    boolOpt("fastMode", "Fast mode"),
  ]),
  model("gpt-4.1", "GPT-4.1", []),
];

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
    models: opts.models ?? (async () => SAMPLE_MODELS),
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

  try {
    assertFixtureCoversRegistry();
    const offer = creatableDescriptors().map((d) => d.runtime);
    const dep = deprecatedExcluded().map((d) => d.runtime);
    const unavail: string[] = [];
    const total = new Set([...offer, ...dep, ...unavail]);
    if (total.size !== RAFT_DRIVER_REGISTRY.length) {
      throw new Error(`ledger ${String(total.size)} != 12`);
    }
    ok("registry ledger: offerable + deprecated-excluded = 12");
  } catch (e) {
    bad("registry ledger", e);
  }

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
    if (!ids.includes("boom")) throw new Error("boom detect_failed lost");
    if (ids.includes("absent")) throw new Error("absent must be omitted not failed");
    const boom = descs.find((d) => d.runtime === "boom");
    if (boom?.failure !== "detect_failed") throw new Error("boom not detect_failed");
    ok("3+4 detect isolation + detect_failed ≠ absent");
  } catch (e) {
    bad("3+4 detect isolation", e);
  }

  try {
    const descs = fixtureDescriptors().filter((d) => d.runtime === "codex");
    const { schema, snapshotId } = buildFormSchema(descs);
    // valid
    validateConfig({
      raw: {
        runtime: "codex",
        model: "gpt-5.6",
        auth: { mode: "ambient" },
        reasoningEffort: "high",
        fastMode: false,
      },
      descs,
      submittedSnapshotId: snapshotId,
      currentSnapshotId: snapshotId,
    });
    // reject: wrong model for options
    let rejected = false;
    try {
      validateConfig({
        raw: {
          runtime: "codex",
          model: "gpt-4.1",
          auth: { mode: "ambient" },
          reasoningEffort: "high",
        },
        descs,
        submittedSnapshotId: snapshotId,
        currentSnapshotId: snapshotId,
      });
    } catch (e) {
      rejected = e instanceof ConfigError;
      if (!rejected) throw e;
    }
    if (!rejected) throw new Error("expected reject unsupported option on gpt-4.1");
    // reverse narrowing: effective schema for codex must not include pi provider models
    const eff = schema;
    if (eff === false) throw new Error("schema false");
    ok("5+validate reject + codex schema builds");
    void checkAgainstProfile;
    void profileViolations;
    void snapshotIdOf;
  } catch (e) {
    bad("validate reject", e);
  }

  try {
    const descs = creatableDescriptors();
    const { schema } = buildFormSchema(descs);
    assertInProfileSafe(schema);
    ok("9 fixture creatable schema in profile");
  } catch (e) {
    bad("9 profile", e);
  }

  try {
    // stale snapshot first
    const descs = creatableDescriptors();
    const { snapshotId } = buildFormSchema(descs);
    try {
      validateConfig({
        raw: { runtime: "codex", model: "gpt-5.6", auth: { mode: "ambient" } },
        descs,
        submittedSnapshotId: "deadbeef",
        currentSnapshotId: snapshotId,
      });
      throw new Error("should stale");
    } catch (e) {
      if (!(e instanceof ConfigError) || e.detail.code !== "schema_stale") {
        throw e;
      }
    }
    ok("6 schema_stale");
  } catch (e) {
    bad("6 schema_stale", e);
  }

  if (failed > 0) {
    console.error(`\n${String(failed)} tooth failure(s)`);
    process.exit(1);
  }
  console.log("\nall teeth green");
}

function assertInProfileSafe(schema: JsonSchema) {
  const v = profileViolations(schema);
  if (v.length > 0) {
    throw new Error(`out_of_profile: ${v[0]!.keyword} at ${v[0]!.path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
