import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

/** A stream that ends before `response.completed`: what codex retries and reports as "Reconnecting". */
const CUT_STREAM = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "cut", object: "response", status: "in_progress", output: [] }, sequence_number: 0 })}\n\n`;

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex reconnects", () => {
  test("a dropped model stream reads as retry events, then the turn completes", async () => {
    let cut = 0;
    const provider = await startCodexAimock((mock) => {
      mock.on({ predicate: () => true }, { content: "RECOVERED" });
    }, {
      rewriteResponse: (body) => {
        if (cut === 2) { return body; }
        cut += 1;
        return CUT_STREAM;
      },
    });
    try {
      const installation = await codexInstallation();
      expectAvailable(installation, "codex");
      const session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env } });
      try {
        expect(await promptAndWait(session, "go", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" }, text: "RECOVERED" });
        const retries = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "error" ? record.body.events : []);
        expect(retries.map((event) => event.kind === "retry" ? event.attempt : null)).toEqual([1, 2]);
        for (const event of retries) { expect(event.kind === "retry" ? event.reason : null).toContain("stream disconnected"); }
      } finally {
        await session.dispose();
      }
    } finally {
      await provider.stop();
    }
  }, 90_000);
});
