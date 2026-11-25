/* oxlint-disable import/max-dependencies -- A real Pi RPC child, its settings files, a probe extension and the bundled entry meet in this test. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startPiAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { piRpc, piSession } from "./support/pi-runtime.js";

/**
 * SessionOptions.piCompaction in Pi's RPC execution mode, measured on the REAL
 * bundled child rather than argued from its types.
 *
 * Three facts pin the contract, and each one is a way the budget could have been
 * applied:
 *
 * 1. The child's compaction budget comes from the settings files Pi loads. A
 *    settings file that declares `reserveTokens`/`keepRecentTokens` makes the
 *    RPC child compact at that trigger, and the run leaves the file byte for
 *    byte as it found it. So the channel is real, and it is the file.
 * 2. OAR refuses `piCompaction` there before the child exists: no session
 *    directory, no settings write, no child. `piCompaction` is honored only by
 *    the in-process execution mode.
 * 3. The escape hatch an extension would need does not exist: the child's
 *    extension API exposes exactly one settings member, `pi.getSettings()`,
 *    which returns a copy with no setter, and the extension context holds no
 *    settings manager. That is why the refusal is a refusal and not a
 *    limitation of OAR's own code.
 *
 * Fact 3 is also the tripwire for the upstream change described in
 * docs/runtimes/pi.md "The compaction budget in the RPC child": when Pi's
 * extension API gains a supported way to override the session's settings, this
 * file starts failing, and OAR can send the budget in the RPC bootstrap
 * document and read it back instead of refusing.
 */

/** The bundled installation: this file exercises OAR's own RPC child, never a host executable. */
const piInstallation = { kind: "available", via: "bundled" } as const;
const MODEL = "aimock/aimock-model";

/** The agent directory the aimock harness pinned for Pi; both execution modes read it from here. */
function pinnedAgentDir(): string {
  const directory = process.env.OAR_PI_AGENT_DIR;
  if (directory === undefined || directory.length === 0) { throw new Error("startPiAimock must pin OAR_PI_AGENT_DIR before a Pi session opens"); }
  return directory;
}

/** Pi's own start/end frames, in order, as OAR observed them. */
function compactionFrames(session: Session): string[] {
  return session.records().flatMap((record) => (record.kind === "frame" && record.body.type.startsWith("compaction_") ? [record.body.type] : []));
}

async function cleanCwd(name: string): Promise<string> {
  // Canonicalize once: Pi's RPC child records its physical cwd for session lookup.
  const directory = await mkdtemp(path.join(tmpdir(), `oar-${name}-`));
  return realpath(directory);
}

/** The probe's API report: the member names an extension can see, in order. */
function apiMembers(text: string): string[] {
  const record = asRecord(parseJson(text));
  const members = record?.members;
  if (!Array.isArray(members)) { throw new TypeError("the probe did not report the extension API surface"); }
  return members.filter((name: unknown): name is string => typeof name === "string");
}

/** The probe's session-start report, narrowed without trusting its shape. */
function probeSession(text: string): { first: unknown; afterMutation: unknown; mode: unknown; contextKeys: string[]; model: unknown } {
  const record = asRecord(parseJson(text));
  if (record === null) { throw new TypeError("the probe did not report its session settings"); }
  const keys = Array.isArray(record.contextKeys) ? record.contextKeys : [];
  return {
    first: record.first, afterMutation: record.afterMutation, mode: record.mode, model: record.model,
    contextKeys: keys.filter((key: unknown): key is string => typeof key === "string"),
  };
}

/**
 * The extension the probe child loads: it reports the API an extension actually
 * gets (names only, no values) and the settings it can read at session start,
 * then deliberately mutates the object it got back so a second read shows
 * whether that object is the live settings or a copy.
 */
const probeSource = String.raw`import { writeFileSync } from "node:fs";
import path from "node:path";

const directory = process.env.OAR_PROBE_DIRECTORY;
if (directory === undefined) { throw new Error("Missing OAR_PROBE_DIRECTORY"); }
const report = (name, value) => { writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 }); };

export default async function probe(pi) {
  // Load time, like OAR's own extension: name every member the API carries.
  report("api.json", { members: Object.keys(pi) });
  pi.on("session_start", async (_event, context) => {
    const first = pi.getSettings().compaction;
    // A copy is a copy: this mutation must not reach the session's settings.
    const handed = pi.getSettings();
    if (handed.compaction !== undefined) { handed.compaction.reserveTokens = 1; }
    report("session.json", {
      first,
      afterMutation: pi.getSettings().compaction,
      mode: context.mode,
      contextKeys: Object.keys(context),
      model: context.model === undefined ? null : context.model.id,
    });
  });
}
`;

/** The bundled RPC entry OAR launches: spawned here exactly as OAR does, with a probe extension instead of OAR's own. */
function bundledEntry(): string {
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

async function waitForReport(directory: string, name: string, child: ChildProcessWithoutNullStreams, diagnostics: () => string): Promise<string> {
  const file = path.join(directory, name);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) { return readFile(file, "utf8"); }
    if (child.exitCode !== null) { break; }
    await sleep(50);
  }
  throw new Error(`the probe extension never wrote ${name}; child said:\n${diagnostics()}`);
}

test.skipIf(!piRpc)("the RPC child compacts at the budget its settings file declares and the run leaves that file untouched", async () => {
  // The same recipe the in-process budget test pins: a reported usage of 15k
  // against a 200k window does NOT cross Pi's own 16384-token headroom
  // (threshold 183_616) and DOES cross the declared 190_000 (threshold 10_000).
  const declared = { reserveTokens: 190_000, keepRecentTokens: 500 };
  const env = await startPiAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, { content: `answered. ${"the quick brown fox jumps over the lazy dog. ".repeat(120)}`, usage: { input_tokens: 15_000, output_tokens: 400 } });
  }, { settings: { compaction: declared } });
  const cwd = await cleanCwd("pi-rpc-budget");
  const settingsFile = path.join(pinnedAgentDir(), "settings.json");
  const onDisk = await readFile(settingsFile, "utf8");
  try {
    const session = await piSession(piInstallation, { cwd, model: MODEL });
    try {
      await runTurn(session, "topic one");
      // The next prompt crosses the declared trigger before it is sent.
      await runTurn(session, "topic two");
      expect(compactionFrames(session)).toEqual(expect.arrayContaining(["compaction_start", "compaction_end"]));
    } finally { await session.dispose(); }
    // Pi read that file and OAR wrote nothing: the declared budget is the file's.
    expect(await readFile(settingsFile, "utf8")).toBe(onDisk);
  } finally {
    await env.stop();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 180_000);

test.skipIf(!piRpc)("the budget is refused before the child starts and the settings file is not written", async () => {
  const env = await startPiAimock(undefined, { settings: { compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 } } });
  const cwd = await cleanCwd("pi-rpc-budget-refused");
  const agentDir = pinnedAgentDir();
  const settingsFile = path.join(agentDir, "settings.json");
  const onDisk = await readFile(settingsFile, "utf8");
  try {
    // A well-formed budget, a valid-shaped one and the invalid inputs the
    // in-process path rejects are all refused the same way here: the option
    // itself has no channel, so no value reaches Pi.
    for (const piCompaction of [{ reserveTokens: 100_000 }, { reserveTokens: 190_000, keepRecentTokens: 500 }, { reserveTokens: 0 }, { reserveTokens: 1.5 }]) {
      await expect(piSession(piInstallation, { cwd, model: MODEL, piCompaction }))
        .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "piCompaction" });
    }
    await expect(piSession(piInstallation, { cwd, model: MODEL, piCompaction: { reserveTokens: 100_000 } }))
      .rejects.toThrow(/in-process execution mode/u);
    // Refused before Pi's child existed: it never opened a session directory,
    // and nothing wrote the settings file OAR refuses to touch.
    expect(existsSync(piSessionDir(cwd, agentDir))).toBe(false);
    expect(await readFile(settingsFile, "utf8")).toBe(onDisk);
  } finally {
    await env.stop();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);

test.skipIf(!piRpc)("the child's extension API reads settings back but cannot set them", async () => {
  const declared = { reserveTokens: 123_456, keepRecentTokens: 789 };
  const env = await startPiAimock(undefined, { settings: { compaction: declared } });
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-rpc-probe-"));
  const extension = path.join(directory, "probe.mjs");
  await writeFile(extension, probeSource, { mode: 0o600 });
  let stderr = "";
  const child = spawn(process.execPath, [
    bundledEntry(),
    "--approve", "--offline", "--no-mcp",
    "--session-dir", path.join(directory, "sessions"),
    "-e", extension, "--no-session", "--model", MODEL,
  ], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: pinnedAgentDir(), OAR_PROBE_DIRECTORY: directory }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
    const members = apiMembers(await waitForReport(directory, "api.json", child, () => stderr));
    const session = probeSession(await waitForReport(directory, "session.json", child, () => stderr));
    expect(session.model).toBe("aimock-model");
    expect(session.mode).toBe("rpc");
    // The channel an extension has into settings is `getSettings` and nothing
    // else: no writer, no manager. This is the assertion to revisit when Pi's
    // extension API grows one (docs/runtimes/pi.md, the RPC budget section).
    expect(members.filter((name) => /settings/iu.test(name))).toEqual(["getSettings"]);
    expect(members.filter((name) => /(applyOverrides|updateSettings|setSettings|settingsManager)/u.test(name))).toEqual([]);
    expect(session.contextKeys.filter((name) => /settings/iu.test(name))).toEqual([]);
    // What it reads is the file's budget, literally, and what it hands out is a
    // copy: the session's settings survive a mutation of that object.
    expect(session.first).toEqual({ reserveTokens: 123_456, keepRecentTokens: 789 });
    expect(session.afterMutation).toEqual({ reserveTokens: 123_456, keepRecentTokens: 789 });
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => { child.once("exit", () => { resolve(); }); child.kill("SIGTERM"); });
    await env.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);
