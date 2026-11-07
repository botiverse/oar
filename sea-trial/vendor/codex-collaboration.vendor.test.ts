/* oxlint-disable import/max-dependencies -- Native fixture, trace and process cleanup need these independent helpers. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { startCodexAimock } from "../harness/aimock.js";
import { openTrace, record } from "../harness/trace.js";
import { expectAvailable, runTurn } from "./support/asserts.js";
import { codexTaskRecipient, codexTaskRequest } from "./support/codex-task-request.js";

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex collaboration input", () => {
  test("wait_agent projects the native operation and null prompt without invented recipients", async () => {
    openTrace("codex-collaboration-input");
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-collab-input-"));
    let rootCalls = 0;
    const provider = await startCodexAimock(mock => {
      mock.on({ predicate: () => true }, async request => {
        if (codexTaskRecipient(request) !== "/root") { await delay(250); return { content: "CHILD_DONE" }; }
        rootCalls += 1;
        if (rootCalls === 1) { return { toolCalls: [{ id: "input_spawn", name: "spawn_agent", arguments: JSON.stringify({ message: "INPUT_CHILD", task_name: "input", fork_turns: "none" }) }] }; }
        if (rootCalls === 2) { return { toolCalls: [{ id: "input_wait", name: "wait_agent", arguments: '{"timeout_ms":10000}' }] }; }
        return { content: "INPUT_DONE" };
      });
    }, {
      rewriteRequest: codexTaskRequest,
      rewriteResponse: body => body.replaceAll('"name":"spawn_agent"', '"name":"spawn_agent","namespace":"collaboration"').replaceAll('"name":"wait_agent"', '"name":"wait_agent","namespace":"collaboration"'),
    });
    try {
      const installation = await codexInstallation();
      expectAvailable(installation, "codex");
      const session = await codexSession(installation, { cwd, env: { ...provider.env }, model: "gpt-6.1-sol", launchArgs: ["-c", "features.multi_agent=true", "-c", "features.multi_agent_v2=true"] });
      session.rawEvents(frame => { record({ kind: "record", record: frame }); });
      try {
        expect(await runTurn(session, "INPUT_ROOT")).toEqual({ kind: "completed" });
        const frames = session.records().filter(r => r.kind === "frame");
        const native = frames.find(r => r.body.type === "item/started" && asRecord(asRecord(r.body.native)?.item)?.id === "input_wait");
        expect(asRecord(asRecord(native?.body.native)?.item)).toMatchObject({ type: "collabAgentToolCall", tool: "wait", prompt: null });
        const events = frames.flatMap(r => r.body.events).filter(e => "callId" in e && e.callId === "input_wait");
        expect(events).toEqual([
          { kind: "tool_call_started", callId: "input_wait", tool: "collabAgentToolCall", input: '{"tool":"wait","prompt":null}' },
          { kind: "tool_call_ended", callId: "input_wait", result: "ok" },
        ]);
      } finally { await session.dispose(); }
    } finally {
      await provider.stop();
      await removeFixtureDirectory(cwd, "codex-collaboration");
    }
  }, 60_000);
});
