import { describe, expect, test } from "vitest";
import { antigravityRuntime, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock, type AcpAimockEnv } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";

async function offered(session: Session, env: AcpAimockEnv): Promise<string[]> {
  const offset = env.raw.length;
  try {
    expect(await promptAndWait(session, "Reply TOOL_FILTER_OK.", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    return [...new Set(env.raw.slice(offset).flatMap((request) => {
      const tools = asRecord(request.body)?.tools;
      return (Array.isArray(tools) ? tools : []).flatMap((tool) => {
        const declarations = asRecord(tool)?.functionDeclarations;
        return (Array.isArray(declarations) ? declarations : []).map((value) => asRecord(value)?.name).filter((name): name is string => typeof name === "string");
      });
    }))].toSorted();
  } finally {
    await session.dispose();
  }
}

describe.skipIf(process.env.OAR_TEST !== "antigravity-aimock")("antigravity disallowedTools", () => {
  test("CLI built-ins remain available; OAR refuses an unenforceable denylist on create and resume", async () => {
    const env = await startAntigravityAimock((mock) => { mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" }); });
    try {
      const subject = runtimeUnderTest(antigravityRuntime, env.env);
      const first = await subject.startSession({ disallowedTools: [] });
      expect(await offered(first, env)).toEqual(expect.arrayContaining(["run_command", "read_file", "write_file"]));
      await expect(subject.startSession({ disallowedTools: ["run_command"] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
      await expect(subject.startSession({ resume: first.id, disallowedTools: ["run_command"] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
      expect(await offered(await subject.startSession({ resume: first.id }), env)).toContain("run_command");
    } finally { await env.stop(); }
  }, 90_000);
});
