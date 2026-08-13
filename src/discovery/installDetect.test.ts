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
  const rows = await detectInstallRegistered([d], ["claude"]);
  assert.equal(rows[0]!.state, "available");
  assert.equal(modelsCalls, 0);
  assert.equal(providersCalls, 0);
});

test("Grok version ok + stdio fail => incompatible, version kept, resolution=command", async () => {
  const grok = stub("grok", async () => ({ version: "1.0.3" }));
  const rows = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => false,
    resolveCommand: () => "/bin/grok",
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
    resolveCommand: () => "/bin/grok",
  });
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.version, "1.0.3");
});

test("OpenCode 1.14.29 => incompatible; 1.14.30 => available", async () => {
  const old = stub("opencode", async () => ({ version: "1.14.29" }));
  const neu = stub("opencode", async () => ({ version: "1.14.30" }));
  const a = await detectInstallRegistered([old], ["opencode"]);
  const b = await detectInstallRegistered([neu], ["opencode"]);
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
  const rows = await detectInstallRegistered([bad, good], ["claude", "codex"]);
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
    resolveCommand: () => "/bin/grok",
  };
  const rows = await detectInstallRegistered([grok], ["grok"], hooks);
  assert.equal(rows[0]!.state, "available");
  assert.equal(rows[0]!.evidence.probeErrorObserved, true);
  assert.equal(rows[0]!.evidence.resolution, "command");
});

test("SDK-only runtime reports resolution=sdk", async () => {
  const pi = stub("pi", async () => ({ version: "0.84.1" }));
  const rows = await detectInstallRegistered([pi], ["pi"]);
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
    resolveCommand: () => "/bin/grok",
  });
  const ungated = await detectInstallRegistered([grok], ["grok"], {
    grokStdioHelp: async () => false,
    grokStdioGate: false,
    resolveCommand: () => "/bin/grok",
  });
  assert.equal(gated[0]!.state, "incompatible");
  assert.equal(ungated[0]!.state, "available", "without the stdio gate, version-only looks available");
});

test("mutation: disable OpenCode min => old version looks available", async () => {
  const old = stub("opencode", async () => ({ version: "1.14.29" }));
  const gated = await detectInstallRegistered([old], ["opencode"]);
  const ungated = await detectInstallRegistered([old], ["opencode"], {
    opencodeMinVersion: null,
  });
  assert.equal(gated[0]!.state, "incompatible");
  assert.equal(ungated[0]!.state, "available");
});
