/* oxlint-disable import/max-dependencies -- Assemble three native fixture protocols and independent configuration evidence. */
/** Six native protocols share the same synthetic MCP experiment. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture, acpId } from "./acp-fixture.js";
import { codexFixture } from "./codex-fixture.js";
import { qoderFixture } from "./qoder-fixture.js";
import { scopedMcp, type McpInvocation } from "./mcp-scope.js";
import { type ProbeTiming } from "./observation.js";
import { directoryConfiguration, type DirectoryConfiguration } from "./directory-configuration.js";

export type ConnectionMode = "shared" | "separate";
export type Label = "A" | "B";
export interface DirectorySession {
  readonly id: string;
  readonly invoke: (input: string) => Promise<{ readonly response: JsonRecord; readonly output: string }>;
}
export interface DirectoryFixture {
  readonly installation: unknown;
  readonly cwd: string;
  readonly configuration: DirectoryConfiguration;
  readonly open: (label: Label) => Promise<DirectorySession>;
  readonly calls: () => Promise<McpInvocation[]>;
  readonly evidence: () => unknown;
  readonly releasedDirectory: (() => Promise<JsonRecord>) | null;
  readonly stop: () => Promise<void>;
}

async function acpDirectoryFixture(runtime: string, mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const fixture = await acpFixture(acpId(runtime), timing);
  const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
  const configuration = await directoryConfiguration({ runtime, cwd, home: fixture.home, kimiHome: fixture.provider.env.KIMI_CODE_HOME });
  let shared: Awaited<ReturnType<typeof fixture.connect>> | undefined = undefined;
  const opened: { connection: Awaited<ReturnType<typeof fixture.connect>>; id: string }[] = [];
  return { installation: fixture.installation, cwd, configuration, calls: fixture.mcpCalls,
    open: async (label) => {
      const connection = mode === "shared" && shared !== undefined ? shared : await fixture.connect();
      shared ??= connection;
      const session = await fixture.open(connection, label, { cwd });
      opened.push({ connection, id: session.id });
      return { id: session.id, invoke: async (input) => {
        const offset = fixture.seen.length;
        const response = await fixture.prompt(connection.child, session.id, input);
        return { response, output: JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === input)) };
      } };
    }, evidence: () => ({ calls: fixture.calls, events: fixture.events, normalized: fixture.seen }),
    releasedDirectory: runtime === "opencode" ? async () => {
      const closed = await Promise.all(opened.map(async ({ connection, id }) => {
        const result = await fixture.request(connection.child, "session/close", { sessionId: id }); return result;
      }));
      assert.ok(shared);
      // Shared reuses the process whose sessions were closed. The control starts
      // a fresh process with the same directory and no client MCP configuration.
      const connection = mode === "shared" ? shared : await fixture.connect();
      const session = await fixture.open(connection, "A", { withMcp: false, cwd });
      await timing.measure("catalog settling after empty-MCP reopen", 3000, async () => { await delay(3000); });
      const offset = fixture.seen.length;
      const response = await fixture.prompt(connection.child, session.id, "A_mcpempty");
      const allCalls = await fixture.mcpCalls();
      const calls = allCalls.filter((call) => call.input === "A_mcpempty");
      const output = JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === "A_mcpempty"));
      return { closed, sessionId: session.id, sentMcpServers: [], response, calls, output,
        retainedMcpInvoked: calls.length > 0, nativeOutputRetained: calls.some((call) => output.includes(call.output)) };
    } : null, stop: async () => { await fixture.stop(); } };
}

async function codexDirectoryFixture(mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const fixture = await codexFixture(timing);
  const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
  const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home });
  let shared: Awaited<ReturnType<typeof fixture.connect>> | undefined = undefined;
  return { installation: fixture.installation, cwd, configuration, calls: fixture.mcpCalls,
    open: async (label) => {
      const connection = mode === "shared" && shared !== undefined ? shared : await fixture.connect();
      shared ??= connection;
      const id = await fixture.open(connection, label, cwd);
      return { id, invoke: async (input) => {
        const offset = fixture.seen.length;
        const response = await fixture.turn(connection, id, input);
        return { response, output: JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === input)) };
      } };
    }, evidence: () => ({ calls: fixture.calls, events: fixture.events, normalized: fixture.seen }), releasedDirectory: null, stop: async () => { await fixture.stop(); } };
}

async function qoderDirectoryFixture(mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const fixture = await qoderFixture(timing);
  const cwd = path.join(fixture.home, "same-directory"); await mkdir(cwd);
  const configuration = await directoryConfiguration({ runtime: "qoder", cwd, home: fixture.home });
  const mcp = await scopedMcp(fixture.home);
  let shared: Awaited<ReturnType<typeof fixture.connect>> | undefined = undefined;
  const opened: Awaited<ReturnType<typeof fixture.open>>[] = [];
  return { installation: fixture.installation, cwd, configuration, calls: mcp.calls,
    open: async (label) => {
      const connection = mode === "shared" && shared !== undefined ? shared : await fixture.connect();
      shared ??= connection;
      const config = path.join(fixture.home, `${label}-mcp.json`);
      await writeFile(config, JSON.stringify({ mcpServers: { scope: { type: "stdio", command: process.execPath, args: [mcp.script, label] } } }), { mode: 0o600 });
      const phases = label === "A" ? ["before", "after", "together"] : ["after", "together"];
      const inputs = phases.map((phase) => `${label}_mcp${phase}`);
      const session = await fixture.open(connection, { cwd, extra: ["--mcp-config", config], replies: inputs.flatMap((input) => [
        { tool: { name: "mcp__scope__echo", args: { text: input } } }, { text: `ANSWER_${input}` },
      ]) });
      opened.push(session);
      let index = 0;
      return { id: session.id, invoke: async (input) => {
        assert.equal(input, inputs[index++], "Qoder native fake-response sequence matches this invocation");
        const offset = fixture.frames.length;
        const response = await fixture.turn(connection, session.id);
        return { response, output: JSON.stringify(fixture.frames.slice(offset).filter((frame) => frame.session_id === session.id)) };
      } };
    }, evidence: () => ({ frames: fixture.frames }), releasedDirectory: async () => {
      const closed = await Promise.all(opened.map(async (session) => {
        const result = await session.control.request({ type: "daemon.close_session" }); return result;
      }));
      assert.ok(shared);
      const connection = mode === "shared" ? shared : await fixture.connect();
      const empty = path.join(fixture.home, "empty-mcp.json");
      await writeFile(empty, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
      const session = await fixture.open(connection, { cwd, extra: ["--mcp-config", empty], replies: [
        { tool: { name: "mcp__scope__echo", args: { text: "A_mcpempty" } } }, { text: "ANSWER_A_mcpempty" },
      ] });
      const offset = fixture.frames.length;
      const response = await fixture.turn(connection, session.id);
      const allCalls = await mcp.calls();
      const calls = allCalls.filter((call) => call.input === "A_mcpempty");
      const output = JSON.stringify(fixture.frames.slice(offset).filter((frame) => frame.session_id === session.id));
      return { closed, sessionId: session.id, sentMcpServers: {}, response, calls, output,
        retainedMcpInvoked: calls.length > 0, nativeOutputRetained: calls.some((call) => output.includes(call.output)) };
    }, stop: async () => { await fixture.stop(); } };
}

export async function directoryFixture(runtime: string, mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  if (runtime === "codex") { const value = await codexDirectoryFixture(mode, timing); return value; }
  if (runtime === "qoder") { const value = await qoderDirectoryFixture(mode, timing); return value; }
  const value = await acpDirectoryFixture(runtime, mode, timing); return value;
}
