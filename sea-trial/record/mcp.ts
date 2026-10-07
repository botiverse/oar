import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { namespaceMcpToolCalls, startClaudeAimock, startCodexAimock, type AimockEnv } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { echoFixtures, startHttpEcho, stdioEcho } from "../vendor/support/echo-mcp.js";
import { structuralToolRound } from "../vendor/support/tool-round.js";
import { scrub as scrubClaude, type RecordRequest } from "./claude.js";
import { scrub as scrubCodex } from "./codex.js";

/*
 * `mcp-echo`: the real claude or codex against a scripted provider (no
 * login, no tokens), opened through oar's OWN session with
 * SessionOptions.mcpServers: a stdio and an http echo server
 * (tests/fixtures/echo-mcp-server.mjs), whose `echo` tool the model calls
 * once each. The recording is the native frames of the session's records,
 * scrubbed like the other recordings: what the runtime said about two MCP
 * calls through servers oar attached. The credentials are fixed strings the
 * servers only fingerprint, so none appears in the recording.
 */

const STEPS = [{ server: "echo", text: "stdio-call" }, { server: "remote", text: "http-call" }];

async function recordThrough(runtime: Runtime, env: AimockEnv, scrub: (type: string, native: unknown) => Record<string, unknown> | null): Promise<Record<string, unknown>[]> {
  const http = await startHttpEcho();
  try {
    const mcpServers: readonly McpServer[] = [
      stdioEcho("echo", "oar-recorded-stdio-credential"),
      { name: "remote", type: "http", url: http.url, headers: { Authorization: "Bearer oar-recorded-http-credential" } },
    ];
    const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers });
    await structuralToolRound(session, env.mock, "please call both echo tools");
    await session.dispose();
    return session.records().flatMap((entry) => {
      const scrubbed = entry.kind === "frame" && entry.agentPath.length === 0 ? scrub(entry.body.type, entry.body.native) : null;
      return scrubbed === null ? [] : [scrubbed];
    });
  } finally {
    http.stop();
    await env.stop();
  }
}

export async function startClaudeMcpRecording(_request: RecordRequest): Promise<Record<string, unknown>[]> {
  const env = await startClaudeAimock((mock) => {
    echoFixtures(mock, /call both echo tools/u, STEPS);
  });
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
  return recordThrough(runtime, env, (_type, native) => scrubClaude(JSON.stringify(native)));
}

export async function startCodexMcpRecording(_request: RecordRequest): Promise<Record<string, unknown>[]> {
  const env = await startCodexAimock((mock) => {
    echoFixtures(mock, /call both echo tools/u, STEPS);
  }, { rewriteResponse: namespaceMcpToolCalls });
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
  // oar opens with experimentalRawEvents, so every model input item comes
  // back as rawResponseItem/completed too (the prompt context, with this
  // machine's paths); the projection reads only the reasoning ones.
  return recordThrough(runtime, env, (type, native) => {
    const params = asRecord(native) ?? {};
    return type === "rawResponseItem/completed" && asRecord(params.item)?.type !== "reasoning" ? null : scrubCodex(type, params);
  });
}
