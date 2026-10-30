/* oxlint-disable import/max-dependencies -- Assemble three native fixture protocols and independent configuration evidence. */
/** Six native protocols share the same synthetic MCP experiment. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasAcpCapability } from "../../packages/oar/src/shared/acp/profile.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { providerRequestsFor } from "./directory-hooks.js";
import { probeFixture } from "./fixture-lifetime.js";
import { acpFixture, acpId } from "./acp-fixture.js";
import { codexFixture } from "./codex-fixture.js";
import { qoderFixture } from "./qoder-fixture.js";
import { scopedMcp, invocationEvidence, type McpInvocation } from "./mcp-scope.js";
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
  readonly releasedDirectory: () => Promise<JsonRecord>;
  readonly stop: () => Promise<void>;
}

async function acpDirectoryFixture(runtime: string, mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const managed = await probeFixture<Omit<DirectoryFixture, "stop">>(async (defer) => {
    const fixture = await acpFixture(acpId(runtime), timing);
    defer(async () => { await fixture.stop(); });
    const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
    const configuration = await directoryConfiguration({ runtime, cwd, home: fixture.home, env: fixture.provider.env });
    let shared: Awaited<ReturnType<typeof fixture.connect>> | null = null;
    const opened: { connection: Awaited<ReturnType<typeof fixture.connect>>; id: string }[] = [];
    return { installation: fixture.installation, cwd, configuration, calls: fixture.mcpCalls,
      open: async (label): Promise<DirectorySession> => {
        const connection = mode === "shared" && shared !== null ? shared : await fixture.connect();
        shared ??= connection;
        const session = await fixture.open(connection, label, { cwd });
        opened.push({ connection, id: session.id });
        return { id: session.id, invoke: async (input): Promise<{ response: JsonRecord; output: string }> => {
          const offset = fixture.seen.length; const rawOffset = fixture.provider.raw.length;
          const response = await fixture.prompt(connection.child, session.id, input);
          return { response, output: JSON.stringify({ normalized: fixture.seen.slice(offset).filter((entry) => entry.key === input), raw: providerRequestsFor(fixture.provider.raw.slice(rawOffset), input) }) };
        } };
      }, evidence: (): unknown => ({ calls: fixture.calls, events: fixture.events, normalized: fixture.seen, raw: fixture.provider.raw }),
      releasedDirectory: async (): Promise<JsonRecord> => {
        const [a, b] = opened; assert.ok(a && b);
        const release = async (session: (typeof opened)[number]): Promise<JsonRecord> => {
          const capabilities = asRecord(asRecord(session.connection.initialized.agentCapabilities)?.sessionCapabilities);
          const closeAdvertised = hasAcpCapability(capabilities?.close);
          // Earlier native evidence includes unadvertised close support. Verify the
          // operation itself; an absent advertisement does not mean method-not-found.
          let nativeClose = true; let result: JsonRecord | null = null;
          try { result = await fixture.request(session.connection.child, "session/close", { sessionId: session.id }); }
          catch (error) {
            if (asRecord(error)?.code !== -32_601) { throw error; }
            nativeClose = false;
          }
          await fixture.terminalFor(session.id).dispose();
          fixture.terminals.delete(session.id);
          return { method: nativeClose ? "session/close" : null, nativeClose, closeAdvertised, result,
            scope: nativeClose ? "Native close and OAR terminal-owner release" : "Native session/close returned method-not-found; OAR terminal-owner release only" };
        };
        const releasedA = await release(a);
        const offset = fixture.seen.length;
        const survivorResponse = await fixture.prompt(b.connection.child, b.id, "B_mcppeerclosed");
        const survivorOutput = JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === "B_mcppeerclosed"));
        const survivor = invocationEvidence(await fixture.mcpCalls(), "B_mcppeerclosed", "B");
        const afterARelease = { response: survivorResponse, output: survivorOutput, invocation: survivor,
          isolated: survivor.isolated && survivor.calls.every((call) => survivorOutput.includes(call.output)) };
        const releasedB = await release(b);
        assert.ok(shared);
        // Shared reuses the process whose sessions were released above. The control starts
        // a fresh process with the same directory and no client MCP configuration.
        const connection = mode === "shared" ? shared : await fixture.connect();
        const session = await fixture.open(connection, "A", { withMcp: false, cwd });
        await timing.measure("catalog settling after empty-MCP reopen", 3000, async () => { await delay(3000); });
        const emptyOffset = fixture.seen.length;
        const response = await fixture.prompt(connection.child, session.id, "A_mcpempty");
        const allCalls = await fixture.mcpCalls();
        const calls = allCalls.filter((call) => call.input === "A_mcpempty");
        const output = JSON.stringify(fixture.seen.slice(emptyOffset).filter((entry) => entry.key === "A_mcpempty"));
        return { observed: true, releasedA, afterARelease, releasedB, sessionId: session.id, sentMcpServers: [], response, calls, output,
          retainedMcpInvoked: calls.length > 0, nativeOutputRetained: calls.some((call) => output.includes(call.output)) };
      } };
  });
  return managed;
}

async function codexDirectoryFixture(mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const managed = await probeFixture<Omit<DirectoryFixture, "stop">>(async (defer) => {
    const fixture = await codexFixture(timing);
    defer(async () => { await fixture.stop(); });
    const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
    const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
    let shared: Awaited<ReturnType<typeof fixture.connect>> | null = null;
    const opened: { connection: Awaited<ReturnType<typeof fixture.connect>>; id: string }[] = [];
    return { installation: fixture.installation, cwd, configuration, calls: fixture.mcpCalls,
      open: async (label): Promise<DirectorySession> => {
        const connection = mode === "shared" && shared !== null ? shared : await fixture.connect();
        shared ??= connection;
        const id = await fixture.open(connection, label, { cwd, bypassHookTrust: true });
        opened.push({ connection, id });
        return { id, invoke: async (input): Promise<{ response: JsonRecord; output: string }> => {
          const offset = fixture.seen.length;
          const response = await fixture.turn(connection, id, input);
          return { response, output: JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === input)) };
        } };
      }, evidence: (): unknown => ({ calls: fixture.calls, events: fixture.events, normalized: fixture.seen }), releasedDirectory: async (): Promise<JsonRecord> => {
        const [a, b] = opened; assert.ok(a && b && shared);
        const releasedA = { method: "thread/unsubscribe", nativeClose: true,
          result: await fixture.request(a.connection, "thread/unsubscribe", { threadId: a.id }) };
        const offset = fixture.seen.length;
        const survivorResponse = await fixture.turn(b.connection, b.id, "B_mcppeerclosed");
        const survivorOutput = JSON.stringify(fixture.seen.slice(offset).filter((entry) => entry.key === "B_mcppeerclosed"));
        const survivor = invocationEvidence(await fixture.mcpCalls(), "B_mcppeerclosed", "B");
        const afterARelease = { response: survivorResponse, output: survivorOutput, invocation: survivor,
          isolated: survivor.isolated && survivor.calls.every((call) => survivorOutput.includes(call.output)) };
        const releasedB = { method: "thread/unsubscribe", nativeClose: true,
          result: await fixture.request(b.connection, "thread/unsubscribe", { threadId: b.id }) };
        const connection = mode === "shared" ? shared : await fixture.connect();
        const id = await fixture.open(connection, "A", { cwd, withMcp: false, bypassHookTrust: true });
        await timing.measure("catalog settling after empty-MCP reopen", 3000, async () => { await delay(3000); });
        const emptyOffset = fixture.seen.length;
        const response = await fixture.turn(connection, id, "A_mcpempty");
        const allCalls = await fixture.mcpCalls();
        const calls = allCalls.filter((call) => call.input === "A_mcpempty");
        const output = JSON.stringify(fixture.seen.slice(emptyOffset).filter((entry) => entry.key === "A_mcpempty"));
        return { observed: true, releasedA, afterARelease, releasedB, sessionId: id, sentMcpServers: {}, response, calls, output,
          retainedMcpInvoked: calls.length > 0, nativeOutputRetained: calls.some((call) => output.includes(call.output)) };
      } };
  });
  return managed;
}

async function qoderDirectoryFixture(mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  const managed = await probeFixture<Omit<DirectoryFixture, "stop">>(async (defer) => {
    const fixture = await qoderFixture(timing);
    defer(async () => { await fixture.stop(); });
    const cwd = path.join(fixture.home, "same-directory"); await mkdir(cwd);
    const configuration = await directoryConfiguration({ runtime: "qoder", cwd, home: fixture.home });
    const mcp = await scopedMcp(fixture.home);
    let shared: Awaited<ReturnType<typeof fixture.connect>> | null = null;
    const connections = new Map<string, Awaited<ReturnType<typeof fixture.connect>>>();
    const opened: Awaited<ReturnType<typeof fixture.open>>[] = [];
    return { installation: fixture.installation, cwd, configuration, calls: mcp.calls,
      open: async (label): Promise<DirectorySession> => {
        const connection = mode === "shared" && shared !== null ? shared : await fixture.connect();
        shared ??= connection;
        const config = path.join(fixture.home, `${label}-mcp.json`);
        await writeFile(config, JSON.stringify({ mcpServers: { scope: { type: "stdio", command: process.execPath, args: [mcp.script, label] } } }), { mode: 0o600 });
        const phases = label === "A" ? ["before", "after", "together"] : ["after", "together", "peerclosed"];
        const inputs = phases.map((phase) => `${label}_mcp${phase}`);
        const session = await fixture.open(connection, { cwd, extra: ["--mcp-config", config], replies: inputs.flatMap((input) => [
          { tool: { name: "mcp__scope__echo", args: { text: input } } }, { text: `ANSWER_${input}` },
        ]) });
        opened.push(session); connections.set(session.id, connection);
        let index = 0;
        return { id: session.id, invoke: async (input): Promise<{ response: JsonRecord; output: string }> => {
          assert.equal(input, inputs[index++], "Qoder native fake-response sequence matches this invocation");
          const offset = fixture.frames.length;
          const response = await fixture.turn(connection, session.id);
          return { response, output: JSON.stringify(fixture.frames.slice(offset).filter((frame) => frame.session_id === session.id)) };
        } };
      }, evidence: (): unknown => ({ frames: fixture.frames }), releasedDirectory: async (): Promise<JsonRecord> => {
        const [a, b] = opened; assert.ok(a && b && shared);
        const releasedA = { method: "daemon.close_session", nativeClose: true,
          result: await a.control.request({ type: "daemon.close_session" }) };
        const offset = fixture.frames.length;
        // Each separate session owns its own connection.
        const survivorConnection = connections.get(b.id); assert.ok(survivorConnection !== undefined);
        const survivorResponse = await fixture.turn(survivorConnection, b.id);
        const survivorOutput = JSON.stringify(fixture.frames.slice(offset).filter((frame) => frame.session_id === b.id));
        const survivor = invocationEvidence(await mcp.calls(), "B_mcppeerclosed", "B");
        const afterARelease = { response: survivorResponse, output: survivorOutput, invocation: survivor,
          isolated: survivor.isolated && survivor.calls.every((call) => survivorOutput.includes(call.output)) };
        const releasedB = { method: "daemon.close_session", nativeClose: true,
          result: await b.control.request({ type: "daemon.close_session" }) };
        const connection = mode === "shared" ? shared : await fixture.connect();
        const empty = path.join(fixture.home, "empty-mcp.json");
        await writeFile(empty, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
        const session = await fixture.open(connection, { cwd, extra: ["--mcp-config", empty], replies: [
          { tool: { name: "mcp__scope__echo", args: { text: "A_mcpempty" } } }, { text: "ANSWER_A_mcpempty" },
        ] });
        const emptyOffset = fixture.frames.length;
        const response = await fixture.turn(connection, session.id);
        const allCalls = await mcp.calls();
        const calls = allCalls.filter((call) => call.input === "A_mcpempty");
        const output = JSON.stringify(fixture.frames.slice(emptyOffset).filter((frame) => frame.session_id === session.id));
        return { observed: true, releasedA, afterARelease, releasedB, sessionId: session.id, sentMcpServers: {}, response, calls, output,
          retainedMcpInvoked: calls.length > 0, nativeOutputRetained: calls.some((call) => output.includes(call.output)) };
      } };
  });
  return managed;
}

export async function directoryFixture(runtime: string, mode: ConnectionMode, timing: ProbeTiming): Promise<DirectoryFixture> {
  if (runtime === "codex") { const value = await codexDirectoryFixture(mode, timing); return value; }
  if (runtime === "qoder") { const value = await qoderDirectoryFixture(mode, timing); return value; }
  const value = await acpDirectoryFixture(runtime, mode, timing); return value;
}
