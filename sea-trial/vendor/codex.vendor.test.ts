import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, defineRuntime } from "../../packages/oar/src/index.js";
import { codexAccountUsage } from "../../packages/oar/src/runtimes/codex/index.js";
import { withProcessEnv } from "./env.js";
import { startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

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
      const result = session.prompt("hello");
      if (result.kind !== "turn") {
        throw new Error("expected a turn");
      }
      await expect(result.turn.outcome).resolves.toMatchInlineSnapshot(`
        {
          "kind": "failed",
          "reason": "failed",
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
        if (installation.kind !== "available") {
          throw new Error("codex unavailable");
        }
        const outcome = await codexAccountUsage(installation, { timeoutMs: 30_000 }).then(
          (value) => ({ resolved: value }),
          (error: unknown) => ({ threw: String(error) }),
        );
        expect(outcome).toMatchInlineSnapshot(`
          {
            "resolved": {
              "kind": "reauth_required",
            },
          }
        `);
      });
    } finally {
      await env.stop();
    }
  }, 60_000);
});
