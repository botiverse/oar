import { describe, expect, it } from "vitest";
import { createMorphRuntime } from "../packages/oar/src/community/morph/index.js";
import { createPiRuntime, defineRuntime, installedSessionCapabilities, opencodeRuntime, type AvailableInstallation } from "../packages/oar/src/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const steer = (installation: AvailableInstallation): boolean | undefined => opencodeRuntime.sessionCapabilities(installation).steer;
const executable = (version?: string): AvailableInstallation => ({ kind: "available", via: "executable", command: "/bin/agent", ...(version === undefined ? {} : { version }) });

describe("Runtime.sessionCapabilities", () => {
  it("is declared by every built-in runtime and answers synchronously", () => {
    for (const runtime of allRuntimes.list()) {
      expect(runtime.sessionCapabilities, runtime.id).toBeTypeOf("function");
      const declared = runtime.sessionCapabilities?.(executable("1.0.0"));
      expect(declared, runtime.id).not.toBeInstanceOf(Promise);
      const known = new Set(["steer", "images", "refusedSessionOptions", "manualCompaction", "compactionEvents"]);
      expect(Object.keys(declared ?? {}).every((key) => known.has(key)), runtime.id).toBe(true);
      // The static declarations are always part of the answer, and the answer is plain data a host can send on.
      expect(declared?.refusedSessionOptions ?? {}, runtime.id).toMatchObject(runtime.refusedSessionOptions ?? {});
      expect(declared?.manualCompaction, runtime.id).toEqual(runtime.manualCompaction);
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

  it("declares OpenCode steering only for a readable v1 version", () => {
    expect(steer(executable("1.14.20"))).toBe(true);
    expect(steer(executable("opencode v1.2.3"))).toBe(true);
    expect(steer(executable("2.3.0"))).toBeUndefined();
    expect(steer(executable("garbage"))).toBeUndefined();
    expect(steer(executable())).toBeUndefined();
    expect(steer({ kind: "available", via: "bundled" })).toBeUndefined();
  });
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
