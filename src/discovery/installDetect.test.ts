import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeDriver } from "../backend/trait.js";
import { emptyDeclaration } from "../backend/trait.js";
import type { ModelInfo } from "../config/model.js";
import type { RuntimeEvent } from "../events/event.js";
import {
  detectInstallRegistered,
  isSupportedOpenCodeVersion,
  MIN_SUPPORTED_OPENCODE_VERSION,
  type DetectAttempt,
  type InstallDetectHooks,
} from "./installDetect.js";

/** Keep default command candidate from seeing the host PATH. */
const isolatePath = {
  commandResolve: {
    platform: "linux" as const,
    execFileSyncFn: (() => {
      throw new Error("not on path");
    }) as never,
  },
};

function stub(
  id: string,
  detect: () => Promise<{ version: string } | null>,
  models: () => Promise<readonly ModelInfo[]> = async () => {
    throw new Error("models() must not be called on install-only path");
  },
): RuntimeDriver {
  return {
    id,
    detect,
    models,
    describe: emptyDeclaration,
    normalise: (_raw: unknown): readonly RuntimeEvent[] => [],
    start: async () => {
      throw new Error("stub: start() not implemented");
    },
  };
}

test("createHostDrivers production ids ask real executables, not driver.id", async () => {
  const asked: string[] = [];
  const { createHostDrivers } = await import("./host/runtimeDrivers.js");
  const { RAFT_DRIVER_REGISTRY } = await import("./fixtures/raftRuntimes.js");
  const rows = await detectInstallRegistered(createHostDrivers(), [...RAFT_DRIVER_REGISTRY], {
    commandResolve: {
      platform: "win32",
      env: {},
      execFileSyncFn: ((_cmd: string, args?: readonly string[]) => {
        const name = String(args?.at(-1) ?? "");
        asked.push(name);
        const hits: Record<string, string> = {
          "cursor-agent": "C:\\npm\\cursor-agent.ps1",
          agy: "C:\\npm\\agy.ps1",
          kimi: "C:\\npm\\kimi.ps1",
        };
        const hit = hits[name];
        if (hit) return Buffer.from(`${hit}\r\n`);
        throw new Error(`not found:${name}`);
      }) as never,
      existsSyncFn: (p: string) => p.endsWith(".cmd"),
      windowsEnvironmentReaderFn: () => ({ machine: {}, user: {} }),
    },
    readVersion: (bin) => {
      if (bin.includes("cursor-agent.cmd")) return "cursor-from-agent";
      if (bin.includes("agy.cmd")) return "agy-from-cmd";
      if (bin.includes("kimi.cmd")) return "kimi-from-cmd";
      return null;
    },
  });
  const byId = Object.fromEntries(rows.map((r) => [r.runtime, r]));
  assert.equal(byId.cursor?.version, "cursor-from-agent");
  assert.equal(byId.antigravity?.version, "agy-from-cmd");
  assert.equal(byId["kimi-cli"]?.version, "kimi-from-cmd");
  assert.ok(asked.includes("cursor-agent"), `asked=${asked.join(",")}`);
  assert.ok(asked.includes("agy"), `asked=${asked.join(",")}`);
  assert.ok(asked.includes("kimi"), `asked=${asked.join(",")}`);
  assert.equal(asked.includes("cursor"), false);
  assert.equal(asked.includes("antigravity"), false);
  assert.equal(asked.includes("kimi-cli"), false);
});

test("OpenCode version gate: 1.14.29 no, 1.14.30 yes", () => {
  assert.equal(MIN_SUPPORTED_OPENCODE_VERSION, "1.14.30");
  assert.equal(isSupportedOpenCodeVersion("1.14.29"), false);
  assert.equal(isSupportedOpenCodeVersion("1.14.30"), true);
  assert.equal(isSupportedOpenCodeVersion("1.16.2"), true);
});

test("install-only never calls models/providers", async () => {
  let modelsCalls = 0;
  let providersCalls = 0;
  const d: RuntimeDriver = {
    ...stub("claude", async () => ({ version: "1.0.0" })),
    models: async () => {
      modelsCalls += 1;
      return [];
    },
    providers: async () => {
      providersCalls += 1;
      return [];
    },
  };
  const rows = await detectInstallRegistered([d], ["claude"], isolatePath);
  assert.equal(rows[0]!.state, "available");
  assert.equal(modelsCalls, 0);
  assert.equal(providersCalls, 0);
});

test("Grok version ok + stdio fail => incompatible, version kept, resolution=command", async () => {
  const grok = stub("grok", async () => ({ version: "1.0.3" }));
  const rows = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => false,
    ...isolatePath,
  });
  assert.equal(rows[0]!.state, "incompatible");
  assert.equal(rows[0]!.reason, "incompatible_stdio");
  assert.equal(rows[0]!.version, "1.0.3");
  assert.equal(rows[0]!.evidence.resolution, "command");
});

test("Grok version ok + stdio ok => available", async () => {
  const grok = stub("grok", async () => ({ version: "1.0.3" }));
  const rows = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => true,
    ...isolatePath,
  });
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.version, "1.0.3");
});

test("OpenCode 1.14.29 => incompatible; 1.14.30 => available", async () => {
  const old = stub("opencode", async () => ({ version: "1.14.29" }));
  const neu = stub("opencode", async () => ({ version: "1.14.30" }));
  const a = await detectInstallRegistered([old], ["opencode"], isolatePath);
  const b = await detectInstallRegistered([neu], ["opencode"], isolatePath);
  assert.equal(a[0]!.state, "incompatible");
  assert.equal(a[0]!.reason, "incompatible_version");
  assert.equal(a[0]!.version, "1.14.29");
  assert.equal(b[0]!.state, "available");
});

test("single driver throw => detect_failed; sweep still complete", async () => {
  const bad = stub("claude", async () => {
    throw new Error("boom");
  });
  const good = stub("codex", async () => ({ version: "0.1.0" }));
  const rows = await detectInstallRegistered([bad, good], ["claude", "codex"], isolatePath);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.runtime, "claude");
  assert.equal(rows[0]!.state, "detect_failed");
  assert.equal(rows[0]!.evidence.probeErrorObserved, true);
  assert.equal(rows[1]!.state, "available");
});

test("candidate throw then success => available + probeErrorObserved=true", async () => {
  const grok = stub("grok", async () => ({ version: "1.0.3" }));
  const hooks: InstallDetectHooks = {
    probeDetect: async (): Promise<DetectAttempt> => ({
      version: "1.0.3",
      probeErrorObserved: true,
    }),
    grokStdioHelp: async () => true,
    ...isolatePath,
  };
  const rows = await detectInstallRegistered([grok], ["grok"], hooks);
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.evidence.probeErrorObserved, true);
  assert.equal(rows[0]!.evidence.resolution, "command");
});

test("SDK-only runtime reports resolution=sdk", async () => {
  const pi = Object.assign(stub("pi", async () => ({ version: "0.84.1" })), {
    installAttempts: () => [
      { resolution: "sdk" as const, run: async () => "0.84.1" },
    ],
  });
  const rows = await detectInstallRegistered([pi], ["pi"], isolatePath);
  assert.equal(rows[0]!.evidence.resolution, "sdk");
  assert.equal(rows[0]!.state, "available");
});

test("missing driver is not_installed resolution=none", async () => {
  const rows = await detectInstallRegistered([], ["kimi-cli"]);
  assert.equal(rows[0]!.state, "not_installed");
  assert.equal(rows[0]!.evidence.resolution, "none");
});

test("mutation: disable Grok stdio gate => version-only false positive (tooth expects this RED in dedicated check)", async () => {
  const grok = stub("grok", async () => ({ version: "1.0.3" }));
  const gated = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => false,
    grokStdioGate: true,
    ...isolatePath,
  });
  const ungated = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => false,
    grokStdioGate: false,
    ...isolatePath,
  });
  assert.equal(gated[0]!.state, "incompatible");
  assert.equal(ungated[0]!.state, "available", "without the stdio gate, version-only looks available");
});

test("production default: command candidate throw then driver.detect wins => probeErrorObserved", async () => {
  const driver = stub("claude", async () => ({ version: "2.0.0" }));
  const rows = await detectInstallRegistered([driver], ["claude"], {
    commandResolve: {
      platform: "win32",
      env: {},
      execFileSyncFn: (() => {
        throw new Error("Get-Command failed");
      }) as never,
      windowsEnvironmentReaderFn: () => ({ machine: { Path: "C:\\M" }, user: { Path: "C:\\U" } }),
    },
  });
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.version, "2.0.0");
  assert.equal(rows[0]!.evidence.probeErrorObserved, true);
  assert.equal(rows[0]!.evidence.resolution, "command");
});

test("production default: Windows refresh fail is bounded diagnostic on the row", async () => {
  const driver = stub("claude", async () => ({ version: "2.0.0" }));
  const rows = await detectInstallRegistered([driver], ["claude"], {
    commandResolve: {
      platform: "win32",
      env: { Path: "C:\\Base" },
      execFileSyncFn: (() => {
        throw new Error("secret path C:\\hidden token=xyz");
      }) as never,
      windowsEnvironmentReaderFn: () => null,
    },
  });
  assert.equal(rows[0]!.diagnostic?.code, "windows_env_refresh_failed");
  const dumped = JSON.stringify(rows[0]);
  assert.equal(dumped.includes("C:\\hidden"), false);
  assert.equal(dumped.includes("token=xyz"), false);
});

test("production default: Get-Command .ps1 prefers sibling .cmd as winning command", async () => {
  const driver = stub("claude", async () => ({ version: "should-not-win" }));
  const rows = await detectInstallRegistered([driver], ["claude"], {
    commandResolve: {
      platform: "win32",
      env: {},
      execFileSyncFn: (() => Buffer.from("C:\\npm\\claude.ps1\r\n")) as never,
      existsSyncFn: (p: string) => p === "C:\\npm\\claude.cmd",
      windowsEnvironmentReaderFn: () => ({ machine: {}, user: {} }),
    },
    readVersion: (bin) => (bin.endsWith(".cmd") ? "from-cmd" : null),
  });
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.version, "from-cmd");
  assert.equal(rows[0]!.evidence.resolution, "command");
  assert.equal(rows[0]!.evidence.probeErrorObserved, false);
});

test("mutation: disable OpenCode min => old version looks available", async () => {
  const old = stub("opencode", async () => ({ version: "1.14.29" }));
  const gated = await detectInstallRegistered([old], ["opencode"], isolatePath);
  const ungated = await detectInstallRegistered([old], ["opencode"], {
    opencodeMinVersion: null,
    ...isolatePath,
  });
  assert.equal(gated[0]!.state, "incompatible");
  assert.equal(ungated[0]!.state, "available");
});
