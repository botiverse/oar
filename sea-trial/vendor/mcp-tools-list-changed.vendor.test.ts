import { piTestRuntime } from "./support/pi-runtime.js";
import type { LLMock } from "@copilotkit/aimock";
import { describe, expect, test } from "vitest";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "../harness/aimock.js";
import { startGrokAimock, startKimiAimock, startOpencodeAimock } from "../harness/aimock-acp.js";
import { allRuntimes } from "../harness/runtimes.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { loadClaudeProbeTools, modelView, runToolsListChanged } from "./support/tools-list-changed.js";

/**
 * `Runtime.mcpToolsListChanged` (#399) on the real harnesses, against a
 * scripted provider: the declaration is what a running session does when an
 * attached server's tools change, so a runtime upgrade that changes it fails
 * here. The client must have listed the tools before the change, and lists
 * them again exactly when the declaration is not "none"; where the requests
 * define MCP tools (all but grok here), the model's view must match too.
 * antigravity and opencode 2.x list MCP tools outside `tools` and were read
 * on their own installs (experiments/mcp-tools-list-changed.ts).
 */

const replyOk = (mock: LLMock): void => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); };

// CI runs claude, codex, pi, OpenCode v1, kimi and grok with local scripted providers.
const backends: readonly { readonly id: string; readonly runtime: string; readonly start: () => Promise<AimockEnv> }[] = [
  { id: "claude-aimock", runtime: "claude", start: async () => startClaudeAimock(loadClaudeProbeTools, { captureRaw: true }) },
  { id: "codex-aimock", runtime: "codex", start: async () => startCodexAimock(replyOk, { captureRaw: true }) },
  { id: "pi-aimock", runtime: "pi", start: async () => startPiAimock(replyOk, { captureRaw: true }) },
  { id: "pi-rpc-aimock", runtime: "pi", start: async () => startPiAimock(replyOk, { captureRaw: true }) },
  { id: "opencode-aimock", runtime: "opencode", start: async () => startOpencodeAimock(replyOk) },
  { id: "kimi-aimock", runtime: "kimi", start: async () => startKimiAimock(replyOk) },
  { id: "grok-aimock", runtime: "grok", start: async () => startGrokAimock(replyOk) },
];

for (const backend of backends) {
  describe.skipIf(process.env.OAR_TEST !== backend.id)(`${backend.id} tools/list_changed`, () => {
    test("a running session takes a change to the served tools as the runtime declares", async () => {
      const runtime = backend.id === "pi-rpc-aimock" ? piTestRuntime : allRuntimes.require(backend.runtime);
      const env = await backend.start();
      try {
        const run = await runToolsListChanged(env, async (server) => runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [server] }));
        const why = JSON.stringify(run.log);
        // The client reached the server before the change, so "never listed again" means something.
        expect(run.connected, why).toBe(true);
        expect(run.relisted, why).toBe(runtime.mcpToolsListChanged !== "none");
        // Where the requests define MCP tools, the model's view decides between full, additions and none.
        const view = modelView(run);
        if (view !== null) {
          expect(view, why).toBe(runtime.mcpToolsListChanged);
        }
        expect(view === null, why).toBe(backend.runtime === "grok");
      } finally {
        await env.stop();
      }
    }, 120_000);
  });
}
