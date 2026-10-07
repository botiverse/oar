import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defineRuntime, piInstallation, piSession, type Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { stdioEcho, STDIO_TOKEN } from "./support/echo-mcp.js";

const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });

/** A real user extension records lifecycle events only while its bound API is usable. */
async function installRecorder(): Promise<() => Promise<unknown>> {
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  if (agentDir === undefined) {
    throw new Error("startPiAimock sets OAR_PI_AGENT_DIR");
  }
  const extensions = path.join(agentDir, "extensions");
  const log = path.join(agentDir, "lifecycle.jsonl");
  await mkdir(extensions, { recursive: true });
  await writeFile(log, "");
  await writeFile(path.join(extensions, "lifecycle.ts"), `
import { appendFileSync } from "node:fs";
export default (pi) => {
  for (const type of ["session_start", "session_shutdown"]) {
    pi.on(type, async (event, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pi.appendEntry("lifecycle", event);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...event, id: ctx.sessionManager.getSessionId() }) + "\\n");
    });
  }
};
`);
  return async () => {
    const content = await readFile(log, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
  };
}

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi extension lifecycle", () => {
  test.each([false, true])("new and resumed sessions bind and await shutdown, mcpServers=%s", async (withMcp) => {
    const env = await startPiAimock((mock) => { mock.on({ userMessage: /hello/u }, { content: "hello" }); });
    const sessions: Session[] = [];
    try {
      const recorded = await installRecorder();
      const subject = runtimeUnderTest(runtime, env.env);
      const options = withMcp ? { mcpServers: [stdioEcho("echo", STDIO_TOKEN)] } : {};
      const session = await subject.startSession(options);
      sessions.push(session);
      const started = { type: "session_start", reason: "startup", id: session.id };
      const stopped = { type: "session_shutdown", reason: "quit", id: session.id };
      expect(await recorded()).toEqual([started]);
      await promptAndWait(session, "hello");
      await session.dispose();
      await session.dispose();
      expect(await recorded()).toEqual([started, stopped]);

      const resumed = await subject.startSession({ ...options, resume: session.id });
      sessions.push(resumed);
      expect(resumed.id).toBe(session.id);
      expect(await recorded()).toEqual([started, stopped, started]);
      await promptAndWait(resumed, "hello again");
      await resumed.dispose();
      await resumed.dispose();
      expect(await recorded()).toEqual([started, stopped, started, stopped]);
    } finally {
      for (const session of sessions) {
        await session.dispose();
      }
      await env.stop();
    }
  }, 120_000);
});
