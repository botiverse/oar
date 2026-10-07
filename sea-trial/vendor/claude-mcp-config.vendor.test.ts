import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { claudeConfigsGone, lateWriterServers } from "./support/claude-fifo.js";
import { currentTurnSays, echoesReceived, echoFixtures, fingerprint, HTTP_AUTHORIZATION, leakedCredentials, startHttpEcho, stdioEcho, STDIO_TOKEN } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

/*
 * The probe for every claude CI installs (it installs the latest): oar hands
 * a session's mcpServers to claude through a FIFO it removes once claude has
 * read it (packages/oar/src/runtimes/claude/mcp-config.ts). That holds only
 * while claude opens the path once, at startup, waits for a writer that comes
 * after it, and keeps the config in memory. When this fails, the handoff needs
 * a new design: a session must never lose its servers silently.
 */

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude --mcp-config handoff", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("claude reads the config once, at startup: it is gone before the first prompt, and a stdio server claude restarts and an http one it initializes again still get their credentials", async () => {
    // --once: the stdio server exits after one call and answers nothing more; the http one answers 404 to the session it made a call in.
    const http = await startHttpEcho(["--once"]);
    const env = await startClaudeAimock((mock) => {
      echoFixtures(mock, /call each echo twice/u, [
        { server: "echo", text: "first-stdio" },
        { server: "remote", text: "first-http" },
        { server: "echo", text: "restarted-stdio" },
        { server: "remote", text: "reinitialized-http" },
      ]);
    }, { captureRaw: true });
    try {
      const mcpServers = [stdioEcho("echo", STDIO_TOKEN, ["--once"]), { name: "remote", type: "http" as const, url: http.url, headers: { Authorization: HTTP_AUTHORIZATION } }];
      const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers });
      if (process.platform !== "win32") {
        expect(await claudeConfigsGone(30_000)).toEqual([]);
      }
      expect(await structuralToolRound(session, env.mock, "please call each echo twice")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "tool_call_started:mcp__remote__echo",
          "tool_call_ended",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "tool_call_started:mcp__remote__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
      const [stdio, remote] = [fingerprint(STDIO_TOKEN), fingerprint(HTTP_AUTHORIZATION)];
      expect(echoesReceived(env.raw)).toEqual([
        `echo:first-stdio via=stdio token=${stdio}`,
        `echo:first-http via=http token=${remote}`,
        `echo:restarted-stdio via=stdio token=${stdio}`,
        `echo:reinitialized-http via=http token=${remote}`,
      ]);
      expect(leakedCredentials(session)).toEqual([]);
    } finally {
      await env.stop();
      http.stop();
    }
  }, 180_000);

  // oar's writer polls, so claude reaches the FIFO first; it must then wait
  // (a blocking open), not read an empty document as a non-blocking one would.
  test.skipIf(process.platform === "win32")("claude reaching the FIFO before its writer waits for it and reads the whole config", async () => {
    const installation = await claudeInstallation();
    if (installation.kind !== "available" || installation.via !== "executable") {
      throw new Error(`claude is ${installation.kind}`);
    }
    const env = await startClaudeAimock((mock) => {
      mock.on({ predicate: currentTurnSays(/late writer/u) }, { content: "ok" });
    });
    try {
      expect(await lateWriterServers(installation.command, env.env ?? {}, [stdioEcho("echo", STDIO_TOKEN)], "late writer")).toMatchInlineSnapshot(`
        [
          {
            "name": "echo",
            "source": "dynamic",
            "status": "connected",
          },
        ]
      `);
    } finally {
      await env.stop();
    }
  }, 120_000);
});
