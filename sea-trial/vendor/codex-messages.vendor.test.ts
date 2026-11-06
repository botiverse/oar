import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";
import { codexMessageReply } from "./support/codex-messages.js";
import { openTrace, record } from "../harness/trace.js";

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex message projection", () => {
  test.each([false, true])("completed text and phase survive (text deltas: %s)", async (deltas) => {
    openTrace(`codex-message-${deltas ? "streamed" : "completed-only"}`);
    const env = await startCodexAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "COMPLETE_TEXT" }); }, {
      rewriteResponse: body => codexMessageReply(body, deltas, "final_answer"),
    });
    try {
      const installation = await codexInstallation();
      expectAvailable(installation, "codex");
      const session = await codexSession(installation, { cwd: process.cwd(), ...(env.env === undefined ? {} : { env: env.env }), model: "gpt-5.1" });
      session.rawEvents(frame => { record({ kind: "record", record: frame }); });
      try {
        expect(await runTurn(session, "Say the marker.")).toEqual({ kind: "completed" });
        const frames = session.records().filter(r => r.kind === "frame");
        const completed = frames.filter(r => r.body.type === "item/completed").map(r => asRecord(asRecord(r.body.native)?.item)).find(item => item?.type === "agentMessage");
        expect(completed).toMatchObject({ text: "COMPLETE_TEXT", phase: "final_answer" });
        const text = frames.flatMap(r => r.body.events).filter(e => e.kind === "text_delta");
        expect(text.map(e => e.text).join("")).toBe("COMPLETE_TEXT");
        expect(text.map(e => ({ messageId: e.messageId, phase: e.phase }))).toEqual([{ messageId: completed?.id, phase: "final_answer" }]);
        expect(frames.some(r => r.body.type === "item/agentMessage/delta")).toBe(deltas);
        expect(frames.filter(r => r.body.type === "item/completed").flatMap(r => r.body.events).filter(e => e.kind === "text_delta")).toHaveLength(deltas ? 0 : 1);
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);
});
