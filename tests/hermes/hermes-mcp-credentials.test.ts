/* oxlint-disable import/max-dependencies -- This test composes the runtime entry, the gateway fixtures and the public contract in one place. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { hermesRuntime } from "../../packages/oar/src/runtimes/hermes/index.js";
import { HERMES_MCP_CREDENTIALS_UNVERIFIED, HERMES_MCP_CREDENTIAL_RELEASE } from "../../packages/oar/src/runtimes/hermes/mcp-credentials.js";

/*
 * Session MCP credentials on Hermes: an `mcpServers` stdio entry whose `env`
 * carries a value. Two fixtures stand in for the two real processes:
 *
 * - `fake-acp-hermes.mjs` is the ACP viewer (`acp_adapter/gateway_server.py`).
 * - `fake-hermes-editor-mcp.mjs` is the gateway owner (`gateway/session_local_mcp.py`):
 *   it spawns the entry, keeps the values in its own memory, and writes a
 *   fingerprint-only policy for the session.
 *
 * `mcp-probe-server.mjs` is the entry itself: a real MCP stdio server that
 * reports the `MCP_PROBE_TOKEN` it was started with and answers `tools/list`
 * and `tools/call`. Both values are synthetic; no real key is used anywhere.
 *
 * `experiments/hermes-acp/mcp-credentials-probe.ts` runs the same assertions
 * against the real daemon.
 */

const gatewayFixture = fileURLToPath(new URL("../fixtures/fake-acp-hermes.mjs", import.meta.url));
const mcpServerFixture = fileURLToPath(new URL("../fixtures/mcp-probe-server.mjs", import.meta.url));

const generationOne = "probe-token-generation-1-4f2b";
const generationTwo = "probe-token-generation-2-9c17";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One test's fixture files: the gateway's HERMES_HOME, its call log and the MCP server's own log. */
interface Scaffold {
  readonly home: string;
  readonly calls: string;
  readonly mcpLog: string;
  readonly executable: string;
}

/** A `hermes` that runs the ACP fixture whatever arguments OAR passes, from any working directory. */
function hermesWrapper(dir: string): string {
  const script = path.join(dir, "hermes-acp-fixture.mjs");
  writeFileSync(script, `process.argv.splice(1, 0, "");\nawait import(${JSON.stringify(gatewayFixture)});\n`);
  if (process.platform === "win32") {
    const cmd = path.join(dir, "hermes.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, "hermes");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function scaffold(): Scaffold {
  const root = scratch("oar-hermes-mcp-credentials-");
  const home = path.join(root, "hermes-home");
  const logs = path.join(root, "logs");
  mkdirSync(home, { recursive: true });
  mkdirSync(logs, { recursive: true });
  return { home, calls: path.join(logs, "gateway-calls.txt"), mcpLog: path.join(logs, "mcp-probe.jsonl"), executable: hermesWrapper(root) };
}

/** Any installation of the fixture, with a version OAR may or may not have measured. */
function installation(version: string | undefined, executable: string): AvailableInstallation {
  return { kind: "available", via: "executable", command: executable, ...(version === undefined ? {} : { version }) };
}

/** A stdio entry whose value must reach the tool process and nowhere OAR keeps. */
function credentialedEntry(token: string): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return { name: "probe", command: process.execPath, args: [mcpServerFixture], env: { MCP_PROBE_TOKEN: token } };
}

function sessionEnv(fixture: Scaffold, extra: Record<string, string> = {}): Record<string, string> {
  return { FAKE_HERMES_CALL_LOG: fixture.calls, FAKE_HERMES_HOME: fixture.home, MCP_PROBE_LOG: fixture.mcpLog, ...extra };
}

/** One open on the measured release; `token` supplies the entry, `resume` continues a session. */
async function openSession(fixture: Scaffold, options: { token?: string; resume?: string } = {}): Promise<Session> {
  return hermesRuntime.session(installation(HERMES_MCP_CREDENTIAL_RELEASE, fixture.executable), {
    cwd: process.cwd(),
    env: sessionEnv(fixture),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.token === undefined ? {} : { mcpServers: [credentialedEntry(options.token)] }),
  });
}

/**
 * One turn in which the model asks for the session MCP tool. The text is the
 * tool's own answer as OAR retained it: the value it names is redacted, which
 * is exactly what a host reading `records()` sees.
 */
async function callTool(session: Session, text = "call-tool"): Promise<string> {
  const turn = await promptAndWait(session, text);
  assert.equal(turn.kind, "ended");
  return session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])
    .flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("");
}

function lines(file: string): readonly string[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter((line) => line.length > 0) : [];
}

/** One JSON document a fixture wrote, narrowed once instead of at every read. */
function readJson(text: string): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON.parse answers `any`; the fixture wrote this document.
  const parsed: Record<string, unknown> = JSON.parse(text);
  return parsed;
}

/** What the tool process reported about the env it was started with, one entry per process start. */
function startedWith(fixture: Scaffold): readonly unknown[] {
  return lines(fixture.mcpLog).map((line) => readJson(line))
    .filter((observation) => observation.event === "start").map((observation) => observation.token);
}

/** Every file under `dir`, so a test can look for a value anywhere the runtime persisted. */
function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name);
    return statSync(entry).isDirectory() ? filesUnder(entry) : [entry];
  });
}

/** The store holds the session's frozen editor MCP manifest: a fingerprint, the schemas and the names. */
function expectPersistedPolicy(persisted: readonly string[]): void {
  const policy = readJson(readFileSync(persisted[0] ?? "", "utf8"));
  expect(Object.keys(policy).toSorted()).toEqual(["fingerprint", "names", "schemas", "scope"]);
  expect(String(policy.fingerprint)).toMatch(/^[\da-f]{64}$/u);
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? `${failure.message}\n${failure.stack ?? ""}` : String(failure);
}

test("the measured release declares an entry with env attachable, and every other release refuses it before anything starts", async () => {
  const fixture = scaffold();
  const measured = installation(HERMES_MCP_CREDENTIAL_RELEASE, fixture.executable);
  // What a host reads before opening and what the open enforces are one rule.
  expect(hermesRuntime.sessionCapabilities(measured).refusedSessionOptions?.mcpServerCredentials).toBeUndefined();

  for (const version of ["0.23.2", "0.23.4", "0.24.0", "0.23.3-rc.1", undefined]) {
    const unmeasured = installation(version, fixture.executable);
    expect(hermesRuntime.sessionCapabilities(unmeasured).refusedSessionOptions?.mcpServerCredentials, String(version)).toBe(HERMES_MCP_CREDENTIALS_UNVERIFIED);
    // oxlint-disable-next-line no-await-in-loop -- one refusal at a time keeps the version attributable.
    await expect(
      hermesRuntime.session(unmeasured, { cwd: process.cwd(), env: sessionEnv(fixture), mcpServers: [credentialedEntry(generationOne)] }),
      String(version),
    ).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers", message: `${HERMES_MCP_CREDENTIALS_UNVERIFIED}: ["probe"]` });
  }
  // Nothing started: no gateway call, no tool process.
  expect(lines(fixture.calls)).toEqual([]);
  expect(startedWith(fixture)).toEqual([]);
});

test("an entry's env reaches the tool process, and OAR's records keep the value redacted", async () => {
  const fixture = scaffold();
  const session = await openSession(fixture, { token: generationOne });

  // The tool answers with the value it was started under; OAR reports it redacted.
  assert.equal(await callTool(session, "call-tool and echo"), "tool:probe:[redacted]:hello");
  expect(startedWith(fixture)).toEqual([generationOne]);
  // The owner's one eager discovery, then the call the model asked for.
  expect(lines(fixture.mcpLog).map((line) => String(readJson(line).event)))
    .toEqual(["start", "initialize", "tools/list", "tools/call"]);
  const records = JSON.stringify(session.records());
  expect(records).toContain("probe:[redacted]:hello");
  expect(records).not.toContain(generationOne);
  // The value itself reached the tool process: the gateway's own copy kept nothing.
  expect(filesUnder(fixture.home).map((file) => readFileSync(file, "utf8")).join("")).not.toContain(generationOne);
  await session.dispose();
});

test("a viewer resuming the session runs the entry under the generation it supplies", async () => {
  const fixture = scaffold();
  const first = await openSession(fixture, { token: generationOne });
  const sessionId = first.id;
  await first.dispose();

  const resumed = await openSession(fixture, { token: generationTwo, resume: sessionId });
  assert.equal(await callTool(resumed, "call-tool and echo"), "tool:probe:[redacted]:hello");
  // The owner replaced the connection, so the new process holds the new values.
  expect(startedWith(fixture)).toEqual([generationOne, generationTwo]);
  expect(lines(fixture.calls)).toContain("session/resume");
  expect(JSON.stringify(resumed.records())).not.toContain(generationTwo);
  await resumed.dispose();
});

test("no value the entry carries reaches the daemon's persisted state or a record", async () => {
  const fixture = scaffold();
  const session = await openSession(fixture, { token: generationTwo });
  await callTool(session);
  await session.dispose();

  const persisted = filesUnder(fixture.home);
  expect(persisted.map((file) => path.relative(fixture.home, file))).toEqual(["editor-mcp-policy.json"]);
  expectPersistedPolicy(persisted);
  expect(persisted.map((file) => readFileSync(file, "utf8")).join("")).not.toContain(generationTwo);
  expect(JSON.stringify(session.records())).not.toContain(generationTwo);
});

test("an open that fails reports no value, even when the gateway quotes it", async () => {
  const fixture = scaffold();
  const opened = await openSession(fixture, { token: generationOne });
  const sessionId = opened.id;
  await opened.dispose();
  const quoted = JSON.stringify({ code: -32_603, message: `Internal error: MCP_PROBE_TOKEN=${generationTwo}`, data: { details: "conflict" } });

  const failure: unknown = await hermesRuntime.session(installation(HERMES_MCP_CREDENTIAL_RELEASE, fixture.executable), {
    cwd: process.cwd(), env: sessionEnv(fixture, { FAKE_HERMES_RESUME_ERROR: quoted }), resume: sessionId, mcpServers: [credentialedEntry(generationTwo)],
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(errorText(failure)).not.toContain(generationTwo);
});

test("an http entry stays refused on the measured release, which advertises no http MCP capability", async () => {
  const fixture = scaffold();
  await expect(hermesRuntime.session(installation(HERMES_MCP_CREDENTIAL_RELEASE, fixture.executable), {
    cwd: process.cwd(), env: sessionEnv(fixture),
    mcpServers: [{ name: "served", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer probe-value-1234" } }],
  })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
  // Refused at the open request, after the handshake that reports no http capability.
  expect(lines(fixture.calls)).toEqual(["initialize"]);
});
