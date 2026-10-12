import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, defineRuntime, usageOf, type Session } from "../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

/** aimock does not script Responses output_tokens_details yet; supply the provider's native field. */
function reasoningUsage(body: string): string {
  return body.split("\n").map((line) => {
    const event = line.startsWith("data: ") ? asRecord(parseJson(line.slice(6))) : null;
    const response = asRecord(event?.response);
    const usage = asRecord(response?.usage);
    if (event?.type !== "response.completed" || usage === null) { return line; }
    return `data: ${JSON.stringify({ ...event, response: { ...response, usage: {
      ...usage, output_tokens_details: { reasoning_tokens: usage.output_tokens === 10 ? 3 : 7 },
    } } })}`;
  }).join("\n");
}

function lastNativeReasoning(session: Session): unknown {
  const values = session.records().flatMap((record) => {
    if (record.kind !== "frame" || record.body.type !== "thread/tokenUsage/updated") { return []; }
    const usage = asRecord(asRecord(record.body.native)?.tokenUsage);
    return [asRecord(usage?.total)?.reasoningOutputTokens];
  });
  return values.at(-1);
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("native reasoning token accounting", () => {
  // oxlint-disable-next-line eslint/max-statements -- A resumed process must expose its own spend and preserve the lifetime native total.
  test("Codex carries nonzero provider reasoning through a resume and JSON replay", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/first/u, { content: "pong", usage: { input_tokens: 1000, output_tokens: 10 } });
      mock.onMessage(/second/u, { content: "pong", usage: { input_tokens: 1200, output_tokens: 20 } });
    }, { rewriteResponse: reasoningUsage });
    const sessions: Session[] = [];
    try {
      const subject = runtimeUnderTest(defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation }), env.env);
      const first = await subject.startSession();
      sessions.push(first);
      expect(await runTurn(first, "first")).toEqual({ kind: "completed" });
      await first.dispose();
      const resumed = await subject.startSession({ resume: first.id });
      sessions.push(resumed);
      expect(await runTurn(resumed, "second")).toEqual({ kind: "completed" });
      expect([lastNativeReasoning(first), lastNativeReasoning(resumed)]).toEqual([3, 10]);
      expect(first.usage().value.total).toMatchObject({ input: 1000, output: 10, reasoning: 3 });
      expect(resumed.usage().value.total).toMatchObject({ input: 1200, output: 20, reasoning: 7 });
      // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- Exercise the persisted record boundary.
      const saved: ReturnType<Session["records"]> = JSON.parse(JSON.stringify(resumed.records()));
      expect(usageOf(saved, resumed.id).value).toEqual(resumed.usage().value);
    } finally {
      await Promise.all(sessions.map(async (session) => session.dispose()));
      await env.stop();
    }
  }, 120_000);
});
