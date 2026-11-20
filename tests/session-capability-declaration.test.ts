import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createMorphRuntime } from "../packages/oar/src/community/morph/index.js";
import { claudeRuntime, codebuddyRuntime, codexRuntime, createCursorRuntime, createPiRuntime, defineRuntime, grokRuntime, installedSessionCapabilities, kimiRuntime, opencodeRuntime, qwenRuntime, type AvailableInstallation } from "../packages/oar/src/index.js";
import { createPiDurableRuntime } from "../packages/oar/src/pi-durable.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const steer = (installation: AvailableInstallation): boolean | undefined => opencodeRuntime.sessionCapabilities(installation).steer;
const executable = (version?: string): AvailableInstallation => ({ kind: "available", via: "executable", command: "/bin/agent", ...(version === undefined ? {} : { version }) });
const unusedSdk = async (): Promise<never> => { await Promise.resolve(); throw new Error("unused"); };

describe("Runtime.sessionCapabilities", () => {
  it("is declared by every built-in runtime and answers synchronously", () => {
    for (const runtime of allRuntimes.list()) {
      expect(runtime.sessionCapabilities, runtime.id).toBeTypeOf("function");
      const declared = runtime.sessionCapabilities?.(executable("1.0.0"));
      expect(declared, runtime.id).not.toBeInstanceOf(Promise);
      const known = new Set(["steer", "images", "refusedSessionOptions", "manualCompaction", "compactionEvents", "contextUsage", "mcpTransports", "stopTask", "fileChanges", "nativeSessionFile", "sideQuestion"]);
      expect(Object.keys(declared ?? {}).every((key) => known.has(key)), runtime.id).toBe(true);
      // The static declarations are always part of the answer, and the answer is plain data a host can send on.
      expect(declared?.refusedSessionOptions ?? {}, runtime.id).toMatchObject(runtime.refusedSessionOptions ?? {});
      expect(declared, runtime.id).toMatchObject(runtime.manualCompaction === undefined ? {} : { manualCompaction: runtime.manualCompaction });
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the property under test.
      const sent: unknown = JSON.parse(JSON.stringify({ brand: runtime.brand, minVersion: runtime.minVersion, declared }));
      expect(sent, runtime.id).toEqual({ brand: runtime.brand, minVersion: runtime.minVersion, declared });
    }
  });

  it("declares the same for every runtime construction", () => {
    expect(createPiRuntime({ execution: "subprocess" }).sessionCapabilities?.(executable("0.80.0"))).toMatchObject({ steer: true, images: true });
    expect(createMorphRuntime().sessionCapabilities?.(executable())).toMatchObject({ steer: true, images: false });
    expect(scriptedRuntime({ turn: () => undefined }).sessionCapabilities?.({ kind: "available", via: "bundled" })).toMatchObject({ steer: true, images: true });
  });

  it("reports OpenCode manual compaction, contextUsage and whole-history fork refusals by installation", () => {
    const v1 = opencodeRuntime.sessionCapabilities(executable("1.19.6"));
    expect(v1).toMatchObject({ manualCompaction: { kind: "unsupported" }, contextUsage: { tokens: true, contextWindow: true } });
    expect(v1.refusedSessionOptions?.fork).toContain("v1");
    expect(v1.refusedSessionOptions?.additionalDirectories).toContain("v1");
    const v2 = opencodeRuntime.sessionCapabilities(executable("opencode v2.3.2"));
    expect(v2).toMatchObject({ manualCompaction: { kind: "supported", activeTurn: "reject" }, contextUsage: { tokens: true, contextWindow: true } });
    expect(v2.refusedSessionOptions?.fork).toBeUndefined();
    const unknown = opencodeRuntime.sessionCapabilities(executable());
    expect([unknown.manualCompaction, unknown.contextUsage, unknown.refusedSessionOptions?.fork]).toEqual([undefined, undefined, undefined]);
  });

  it("declares OpenCode steering only for a readable v1 version", () => {
    expect(steer(executable("1.14.20"))).toBe(true);
    expect(steer(executable("opencode v1.2.3"))).toBe(true);
    expect(steer(executable("2.3.0"))).toBeUndefined();
    expect(steer(executable("garbage"))).toBeUndefined();
    expect(steer(executable())).toBeUndefined();
    expect(steer({ kind: "available", via: "bundled" })).toBeUndefined();
  });
});

it("offers side questions only on verified Claude installations", () => {
  for (const version of [undefined, "unreadable", "2.1.325", "2.1.326-rc.1"]) {
    expect(claudeRuntime.sessionCapabilities(executable(version)).sideQuestion).toBe(false);
  }
  expect(claudeRuntime.sessionCapabilities(executable("2.1.326")).sideQuestion).toBe(true);
  expect(claudeRuntime.sessionCapabilities({ kind: "available", via: "bundled" }).sideQuestion).toBe(false);
});

describe("SessionCapabilityDeclaration.contextUsage", () => {
  it("declares per-installation contextUsage across default built-in runtimes", () => {
    const byId = new Map(allRuntimes.list().map((runtime) => [runtime.id, runtime.sessionCapabilities?.(executable("2.3.2")).contextUsage]));
    for (const id of ["antigravity", "claude", "codex", "dsh", "factory", "kimi", "opencode", "pi", "qwen"]) {
      expect(byId.get(id), id).toEqual({ tokens: true, contextWindow: true });
    }
    expect(byId.get("grok")).toEqual({ tokens: true, contextWindow: false });
    expect(byId.get("codebuddy")).toEqual({ tokens: false, contextWindow: false });
    expect(byId.get("qoder")).toEqual({ tokens: false, contextWindow: false });
    expect(byId.get("devin")).toBeUndefined();
  });

  it("declares contextUsage on constructed built-in runtimes (pi subprocess, cursor, pi-durable)", async () => {
    expect(createPiRuntime({ execution: "subprocess" }).sessionCapabilities?.(executable("1.4.0")).contextUsage).toEqual({ tokens: true, contextWindow: true });
    expect(createCursorRuntime({ sdk: unusedSdk }).sessionCapabilities?.({ kind: "available", via: "bundled" }).contextUsage).toEqual({ tokens: true, contextWindow: false });
    const models = createModels();
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      expect(createPiDurableRuntime({ harness, models }).sessionCapabilities?.({ kind: "available", via: "bundled" }).contextUsage).toEqual({ tokens: false, contextWindow: false });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it.each([
    ["codex-cli 0.150.1", undefined],
    ["codex-cli 0.151.0-beta.1", undefined],
    ["codex-cli 0.151.0", { tokens: true, contextWindow: true }],
    ["codex-cli 0.170.0", { tokens: true, contextWindow: true }],
    [undefined, undefined],
  ] as const)("gates Codex contextUsage at 0.151.0 (%s)", (version, expected) => {
    expect(codexRuntime.sessionCapabilities(executable(version)).contextUsage).toEqual(expected);
  });

  it.each([
    ["0.25.9", undefined],
    ["0.26.0-rc.1", undefined],
    ["0.26.0", { tokens: true, contextWindow: true }],
    ["0.28.0", { tokens: true, contextWindow: true }],
    [undefined, undefined],
  ] as const)("gates Qwen contextUsage at 0.26.0 (%s)", (version, expected) => {
    expect(qwenRuntime.sessionCapabilities(executable(version)).contextUsage).toEqual(expected);
  });
});

describe("SessionCapabilityDeclaration.stopTask", () => {
  it("declares stopTask across default built-in runtimes", () => {
    const byId = new Map(allRuntimes.list().map((runtime) => [runtime.id, runtime.sessionCapabilities?.(executable("2.3.2")).stopTask]));
    for (const id of ["claude", "codex", "dsh", "qoder"]) {
      expect(byId.get(id), id).toBe(true);
    }
    for (const id of ["antigravity", "codebuddy", "devin", "factory", "grok", "kimi", "opencode", "pi", "qwen"]) {
      expect(byId.get(id), id).toBe(false);
    }
    expect(opencodeRuntime.sessionCapabilities(executable()).stopTask).toBe(false);
  });

  it("declares stopTask on constructed built-in runtimes", async () => {
    expect(createPiRuntime({ execution: "subprocess" }).sessionCapabilities?.(executable("1.4.0")).stopTask).toBe(false);
    expect(createCursorRuntime({ sdk: unusedSdk }).sessionCapabilities?.({ kind: "available", via: "bundled" }).stopTask).toBe(false);
    const models = createModels();
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      expect(createPiDurableRuntime({ harness, models }).sessionCapabilities?.({ kind: "available", via: "bundled" }).stopTask).toBe(false);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("SessionCapabilityDeclaration.mcpTransports", () => {
  it("declares verified mcpTransports across default built-in runtimes", () => {
    const byId = new Map(allRuntimes.list().map((runtime) => [runtime.id, runtime.sessionCapabilities?.(executable("2.178.1")).mcpTransports]));
    for (const id of ["antigravity", "claude", "codebuddy", "codex", "grok", "kimi", "opencode", "pi", "qoder", "qwen"]) {
      expect(byId.get(id), id).toEqual(["stdio", "http"]);
    }
    expect(byId.get("dsh")).toEqual(["stdio"]);
    expect(byId.get("devin")).toBeUndefined();
    expect(byId.get("factory")).toBeUndefined();
  });

  it("declares mcpTransports on constructed built-in runtimes", async () => {
    expect(createPiRuntime({ execution: "subprocess" }).sessionCapabilities?.(executable("1.4.0")).mcpTransports).toEqual(["stdio", "http"]);
    expect(createCursorRuntime({ sdk: unusedSdk }).sessionCapabilities?.({ kind: "available", via: "bundled" }).mcpTransports).toEqual(["stdio", "http"]);
    const models = createModels();
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      expect(createPiDurableRuntime({ harness, models }).sessionCapabilities?.({ kind: "available", via: "bundled" }).mcpTransports).toEqual([]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it.each([
    ["0.25.9", ["stdio"]],
    ["0.26.0-rc.1", ["stdio"]],
    ["0.26.0", ["stdio", "http"]],
    ["0.28.0", ["stdio", "http"]],
    ["garbage", undefined],
    [undefined, undefined],
  ] as const)("gates Qwen mcpTransports at 0.26.0 (%s)", (version, expected) => {
    expect(qwenRuntime.sessionCapabilities(executable(version)).mcpTransports).toEqual(expected);
  });

  it.each([
    [opencodeRuntime, "1.18.29", undefined],
    [opencodeRuntime, "1.18.30", ["stdio", "http"]],
    [opencodeRuntime, "opencode v2.0.25", undefined],
    [opencodeRuntime, "opencode v2.0.26", ["stdio", "http"]],
    [opencodeRuntime, undefined, undefined],
    [grokRuntime, "1.0.45", undefined],
    [grokRuntime, "1.0.46", ["stdio", "http"]],
    [kimiRuntime, "2.1.0", undefined],
    [kimiRuntime, "2.1.1", ["stdio", "http"]],
    [codebuddyRuntime, "2.178.0", undefined],
    [codebuddyRuntime, "2.178.1", ["stdio", "http"]],
  ] as const)("gates ACP runtime mcpTransports at verified version floors (%#)", (runtime, version, expected) => {
    expect(runtime.sessionCapabilities(executable(version)).mcpTransports).toEqual(expected);
  });
});

it.each([
  ["0.25.9", true],
  ["0.26.0-rc.1", true],
  ["0.26.0", false],
  ["0.28.0", false],
  [undefined, true],
] as const)("gates Qwen nativeMemoryDefault refusal at 0.26.0 (%s)", (version, refused) => {
  const declaration = qwenRuntime.sessionCapabilities(executable(version)).refusedSessionOptions;
  expect(declaration?.nativeMemoryDefault === undefined).toBe(!refused);
});

describe("installedSessionCapabilities", () => {
  const base = { id: "probe", session: scriptedRuntime({ turn: () => undefined }).session };
  it("merges an installation's refusals over the static ones and keeps a per-version manual compaction", () => {
    const runtime = defineRuntime({
      ...base,
      refusedSessionOptions: { fork: "static reason" },
      manualCompaction: { kind: "unsupported", reason: "static" },
      sessionCapabilities: (installation: AvailableInstallation) => installation.via === "executable" && installation.version === "1.0.0"
        ? { steer: true, refusedSessionOptions: { systemPrompt: "below the floor" }, manualCompaction: { kind: "supported", activeTurn: "reject" }, compactionEvents: { started: true, ended: true } }
        : { steer: true },
    });
    expect(runtime.sessionCapabilities(executable("1.0.0"))).toEqual({
      steer: true, refusedSessionOptions: { fork: "static reason", systemPrompt: "below the floor" },
      manualCompaction: { kind: "supported", activeTurn: "reject" }, compactionEvents: { started: true, ended: true },
    });
    expect(runtime.sessionCapabilities(executable("2.0.0"))).toEqual({ steer: true, refusedSessionOptions: { fork: "static reason" }, manualCompaction: { kind: "unsupported", reason: "static" } });
  });

  it("answers for a runtime without the member, and merging twice changes nothing", () => {
    const plain = { refusedSessionOptions: { name: "no native name" } };
    expect(installedSessionCapabilities(plain, executable())).toEqual({ refusedSessionOptions: { name: "no native name" } });
    expect(installedSessionCapabilities({}, executable())).toEqual({});
    const defined = defineRuntime({ ...base, refusedSessionOptions: { name: "no native name" } });
    expect(installedSessionCapabilities(defined, executable())).toEqual(defined.sessionCapabilities(executable()));
  });
});

describe("a host's wrapper", () => {
  it("answers with the wrapper's own static declarations, not the ones it spread from", () => {
    const original = defineRuntime({ id: "probe", session: scriptedRuntime({ turn: () => undefined }).session, refusedSessionOptions: { goals: "static" }, manualCompaction: { kind: "supported", activeTurn: "reject" } });
    const wrapped = { ...original, refusedSessionOptions: {}, manualCompaction: { kind: "unsupported", reason: "wrapper" } as const };
    expect(wrapped.sessionCapabilities(executable())).toEqual({ manualCompaction: { kind: "unsupported", reason: "wrapper" } });
    expect(installedSessionCapabilities(wrapped, executable())).toEqual({ manualCompaction: { kind: "unsupported", reason: "wrapper" } });
    expect(opencodeRuntime.sessionCapabilities(executable("2.3.2")).refusedSessionOptions).toEqual(opencodeRuntime.refusedSessionOptions);
  });
});

it.each([
  ["2.0.29", true, true], ["2.0.30-beta.1", true, true], ["2.0.30", false, true],
  ["2.1.4", false, true], ["2.2.0-rc.1", false, true], ["2.2.0", false, false], ["2.3.2", false, false],
] as const)("declares OpenCode %s prompt refusals at the measured floors", (version, append, replace) => {
  const refused = opencodeRuntime.sessionCapabilities(executable(version)).refusedSessionOptions;
  expect(refused?.appendSystemPrompt).toEqual(append ? expect.stringContaining("2.0.30 or later") : undefined);
  expect(refused?.systemPrompt).toEqual(replace ? expect.stringContaining("2.2.0 or later") : undefined);
});


it("Codex declares per-file kinds from the first verified native version", () => {
  expect(codexRuntime.sessionCapabilities(executable("0.160.1")).fileChanges).toBe(true);
  expect(codexRuntime.sessionCapabilities(executable()).fileChanges).toBeUndefined();
  expect(codexRuntime.sessionCapabilities(executable("0.159.0")).fileChanges).toBeUndefined();
});
