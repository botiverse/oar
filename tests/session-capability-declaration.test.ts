import { describe, expect, it } from "vitest";
import { createMorphRuntime } from "../packages/oar/src/community/morph/index.js";
import { createPiRuntime, opencodeRuntime, type AvailableInstallation } from "../packages/oar/src/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const executable = (version?: string): AvailableInstallation => ({ kind: "available", via: "executable", command: "/bin/agent", ...(version === undefined ? {} : { version }) });

describe("Runtime.sessionCapabilities", () => {
  it("is declared by every built-in runtime and answers synchronously", () => {
    for (const runtime of allRuntimes.list()) {
      expect(runtime.sessionCapabilities, runtime.id).toBeTypeOf("function");
      const declared = runtime.sessionCapabilities?.(executable("1.0.0"));
      expect(declared, runtime.id).not.toBeInstanceOf(Promise);
      expect(Object.keys(declared ?? {}).every((key) => key === "steer" || key === "images"), runtime.id).toBe(true);
    }
  });

  it("declares the same for every runtime construction", () => {
    expect(createPiRuntime({ execution: "subprocess" }).sessionCapabilities?.(executable("0.80.0"))).toEqual({ steer: true, images: true });
    expect(createMorphRuntime().sessionCapabilities?.(executable())).toEqual({ steer: true, images: false });
    expect(scriptedRuntime({ turn: () => undefined }).sessionCapabilities?.({ kind: "available", via: "bundled" })).toEqual({ steer: true, images: true });
  });

  it("declares OpenCode steering only for a readable v1 version", () => {
    expect(opencodeRuntime.sessionCapabilities(executable("1.14.20"))).toEqual({ steer: true });
    expect(opencodeRuntime.sessionCapabilities(executable("opencode v1.2.3"))).toEqual({ steer: true });
    expect(opencodeRuntime.sessionCapabilities(executable("2.3.0"))).toEqual({});
    expect(opencodeRuntime.sessionCapabilities(executable("garbage"))).toEqual({});
    expect(opencodeRuntime.sessionCapabilities(executable())).toEqual({});
    expect(opencodeRuntime.sessionCapabilities({ kind: "available", via: "bundled" })).toEqual({});
  });
});
