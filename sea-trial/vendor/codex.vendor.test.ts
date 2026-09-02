import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, defineRuntime } from "../../packages/oar/src/index.js";
import { codexAccountUsage } from "../../packages/oar/src/runtimes/codex/index.js";
import { assertContextUsage, expectAvailable, promptTurn, withProcessEnv } from "./support/asserts.js";
import { startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { structuralToolRound, toolRoundFixtures } from "./support/tool-round.js";
import { APPEND_MARKER, REPLACE_MARKER, lastAgentSystem, scrubSystem, systemCapture } from "./support/system-prompt.js";

/** Vendor-specific error edges for the real codex app-server (scripted provider). */
describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex vendor error edges", () => {
  test("an invalid request fails the turn fast with the API error", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
        status: 400,
      });
    });
    try {
      const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      const result = promptTurn(session, "hello");
      await expect(result.outcome).resolves.toMatchInlineSnapshot(`
        {
          "failure": "invalid_request",
          "kind": "failed",
          "reason": "failed: {"error":{"message":"max_tokens exceeds model limit","type":"invalid_request_error","param":null,"code":null}}",
        }
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("account usage under an API key (no ChatGPT login)", async () => {
    const env = await startCodexAimock();
    try {
      await withProcessEnv(env.env ?? {}, async () => {
        const installation = await codexInstallation();
        expectAvailable(installation, "codex");
        const outcome = await codexAccountUsage(installation, { timeoutMs: 30_000 }).then(
          (value) => ({ resolved: value }),
          (error: unknown) => ({ threw: String(error) }),
        );
        expect(outcome).toMatchInlineSnapshot(`
          {
            "resolved": {
              "kind": "unsupported",
            },
          }
        `);
      });
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("a scripted two-round tool conversation keeps tool framing", async () => {
    const env = await startCodexAimock((mock) => {
      toolRoundFixtures(mock, (command) => ({ name: "exec_command", arguments: JSON.stringify({ cmd: command }) }));
    });
    try {
      // Full access ON PURPOSE: this test pins tool-call FRAMING, and
      // sandboxed exec is platform-dependent (GitHub runners deny it — the
      // echoed marker never reaches the tool result and the staged fixtures
      // miss; root-caused via the request journal in CI run 32616926011).
      await withProcessEnv({ OAR_CODEX_SANDBOX: "danger-full-access" }, async () => {
        const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
        const session = await runtimeUnderTest(runtime, env.env).startSession();
        await expect(structuralToolRound(session, env.mock)).resolves.toMatchInlineSnapshot(`
          [
            "turn_started",
            "tool_call_started:commandExecution",
            "tool_call_ended",
            "tool_call_started:commandExecution",
            "tool_call_ended",
            "turn_ended:completed",
          ]
        `);
        await session.dispose();
      });
    } finally {
      await env.stop();
    }
  }, 120_000);


  test("system prompt replace+append land on the provider request", async () => {
    const capture = systemCapture();
    const env = await startCodexAimock((mock) => { capture.configure(mock); });
    try {
      const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession({
        systemPrompt: `${REPLACE_MARKER} you are the oar probe agent`,
        appendSystemPrompt: `${APPEND_MARKER} always be brief`,
      });
      const first = promptTurn(session, "hello there");
      await first.outcome;
      // Compaction-survival for codex lands with the compact() capability:
      // thread/compact/start is not reachable through the Session API yet.
      expect(scrubSystem(lastAgentSystem(capture.systems))).toMatchInlineSnapshot(`
        "OAR-SYSTEM-REPLACE-MARKER you are the oar probe agent
        OAR-SYSTEM-APPEND-MARKER always be brief<skills_instructions>…(version-dependent skill catalog scrubbed)…</skills_instructions><permissions instructions>
        Filesystem sandboxing defines which files can be read or written. \`sandbox_mode\` is \`danger-full-access\`: No filesystem sandboxing - all commands are permitted. Network access is enabled.
        Approval policy is currently never. Do not provide the \`sandbox_permissions\` for any reason, commands will be rejected.
        </permissions instructions>"
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("contextUsage() returns a well-formed snapshot after a turn", async () => {
    const env = await startCodexAimock();
    try {
      const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      const turn = promptTurn(session, "say hi");
      await turn.outcome;
      assertContextUsage(session.contextUsage?.());
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);
});
