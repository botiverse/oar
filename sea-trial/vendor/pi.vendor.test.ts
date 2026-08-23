import { describe, expect, test } from "vitest";
import { piInstallation, piSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

/** Vendor-specific error edges for the in-process pi SDK (scripted provider). */
describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi vendor error edges", () => {
  test("an invalid request settles the turn with the provider error", async () => {
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
        status: 400,
      });
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession();
      const result = session.prompt("hello");
      if (result.kind !== "turn") {
        throw new Error("expected a turn");
      }
      await expect(result.turn.outcome).resolves.toMatchInlineSnapshot(`
        {
          "failure": "invalid_request",
          "kind": "failed",
          "reason": "400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens exceeds model limit"}}",
        }
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);
});
