import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  test("native built-in exclusion persists on resume; unrelated tools stay; an explicit empty list clears it", async () => {
    const env = await startAntigravityAimock((mock) => { mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" }); });
    try {
      const subject = runtimeUnderTest(antigravityRuntime, env.env);
      expect(await offered(await subject.startSession(), env)).toEqual(expect.arrayContaining(["run_command", "view_file", "write_to_file"]));
      const disallowedTools = ["run_command", "view_file"];
      const restricted = await subject.startSession({ disallowedTools });
      const tools = await offered(restricted, env);
      expect(tools).not.toContain("run_command");
      expect(tools).not.toContain("view_file");
      expect(tools).toContain("write_to_file");
      const resumed = await offered(await subject.startSession({ resume: restricted.id, disallowedTools }), env);
      expect(resumed).not.toContain("run_command");
      expect(resumed).not.toContain("view_file");
      expect(resumed).toContain("write_to_file");
      const cleared = await offered(await subject.startSession({ resume: restricted.id, disallowedTools: [] }), env);
      expect(cleared).toEqual(expect.arrayContaining(["run_command", "view_file", "write_to_file"]));
    } finally {
      await env.stop();
    }
  }, 180_000);

  // A model that calls a filtered built-in anyway gets nothing run. Unlike the
  // runtimes whose deny channel is per open, antigravity saves its filter:
  // a resume that omits the list keeps it (runtime-matrix.md#disallowed-tools).
  test("a denied built-in the model calls anyway is not run; a resume that omits the list keeps the saved filter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oar-denied-"));
    const marker = path.join(dir, "ran");
    const env = await startAntigravityAimock((mock) => {
      mock.onMessage(/TOOL_FILTER_OK/u, { content: "TOOL_FILTER_OK" });
      mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: false }, { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command_line: `echo ran > ${marker}`, working_dir: dir }) }] });
      mock.on({ userMessage: /CALL_DENIED/u, hasToolResult: true }, { content: "done" });
    });
    try {
      const subject = runtimeUnderTest(antigravityRuntime, env.env);
      const restricted = await subject.startSession({ disallowedTools: ["run_command"] });
      expect(await promptAndWait(restricted, "CALL_DENIED", { timeoutMs: 90_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(existsSync(marker)).toBe(false);
      await restricted.dispose();
      expect(await offered(await subject.startSession({ resume: restricted.id }), env)).not.toContain("run_command");
    } finally {
      await env.stop();
    }
  }, 180_000);
});
