/* oxlint-disable import/max-dependencies -- One repeatable real-runtime probe composes the adapter, a scripted provider, an MCP server and the public session API. */
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermesRuntime } from "../../packages/oar/src/runtimes/hermes/index.js";
import { HERMES_MCP_CREDENTIAL_RELEASE } from "../../packages/oar/src/runtimes/hermes/mcp-credentials.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { startToolCallingProvider } from "./tool-calling-provider.js";

/*
 * Repeatable evidence for Hermes session MCP credentials: the real `hermes
 * acp` viewer and daemon, with a local MCP server as the session's stdio
 * entry. It proves, on this machine and with no account:
 *
 *   1. the daemon spawns the entry and the tool process receives the entry's
 *      `env` (the value is synthetic), answers `tools/list`, and answers a
 *      `tools/call` the model asked for;
 *   2. resuming the same conversation with a new generation of values makes
 *      the daemon start the tool process under the new values;
 *   3. OAR's records carry neither value (the tool's own answer is redacted);
 *   4. nothing under the temporary HERMES_HOME holds either value.
 *
 * Run it against an installed 0.23.3 (the release OAR measured):
 *
 *   hermes pm install --extra acp
 *   OAR_HERMES_BIN=/absolute/path/to/hermes \
 *     pnpm tsx experiments/hermes-acp/mcp-credentials-probe.ts
 *
 * A source checkout has no `.git` or install stamp, so `hermes --version`
 * prints `vunknown` there and OAR refuses credentialed entries (by design).
 * Write the release into the checkout's stamp first, with Hermes' own script:
 *
 *   python scripts/write_install_stamp.py --output install-stamp.json \
 *     --base-version 0.23.3 --distance 0 --update-mechanism self \
 *     --source local --commit <40 hex characters>
 *
 * Set OAR_HERMES_PYTHONPATH when the `acp` package lives outside the
 * interpreter the launcher runs (a wheel on PYTHONPATH); it is forwarded.
 */

const command = process.env.OAR_HERMES_BIN ?? "hermes";
const mcpServer = fileURLToPath(new URL("../../tests/fixtures/mcp-probe-server.mjs", import.meta.url));
const generationOne = "probe-token-generation-1-4f2b";
const generationTwo = "probe-token-generation-2-9c17";

const root = mkdtempSync(path.join(tmpdir(), "oar-hermes-mcp-credentials-"));
const home = path.join(root, "hermes-home");
const mcpLog = path.join(root, "mcp-probe.jsonl");
const env: Record<string, string> = { OAR_HERMES_BIN: command, HERMES_HOME: home,
  ...(process.env.OAR_HERMES_PYTHONPATH === undefined ? {} : { PYTHONPATH: process.env.OAR_HERMES_PYTHONPATH }) };

interface Observation {
  readonly token?: unknown;
  readonly event?: unknown;
  readonly argument?: unknown;
}

function observations(): readonly Observation[] {
  if (!existsSync(mcpLog)) { return []; }
  return readFileSync(mcpLog, "utf8").trim().split("\n").filter((line) => line.length > 0)
    .map((line) => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON.parse answers `any`; the MCP server wrote this line.
      const observation: Observation = JSON.parse(line);
      return observation;
    });
}

/** What the tool process reported about the values it started with, in start order. */
function startedWith(): readonly unknown[] {
  return observations().filter((observation) => observation.event === "start").map((observation) => observation.token);
}

/** The stdio entry: the value under test, and where the tool process reports what it received. */
function entry(token: string): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return { name: "probe", command: process.execPath, args: [mcpServer], env: { MCP_PROBE_TOKEN: token, MCP_PROBE_LOG: mcpLog } };
}

function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });
}

/** Which files the daemon wrote hold `value`, named without printing their text. */
function persistedValues(value: string): readonly string[] {
  return filesUnder(home).filter((file) => readFileSync(file, "utf8").includes(value)).map((file) => path.relative(home, file));
}

function turnText(session: Session): string {
  return session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])
    .flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("");
}

function holds(session: Session, value: string): boolean {
  return JSON.stringify(session.records()).includes(value);
}

async function stopGateway(): Promise<void> {
  const child = spawn(command, ["gateway", "stop"], { env: { ...process.env, ...env }, stdio: "ignore" });
  await once(child, "exit");
}

async function prompt(session: Session, text: string): Promise<string> {
  const turn = await promptAndWait(session, text);
  if (turn.kind !== "ended") { throw new Error(`the turn did not end (${turn.kind})`); }
  return turnText(session);
}

/** The open session, so a failure anywhere still disposes it. */
const current: { session: Session | null } = { session: null };
try {
  const installation = await hermesRuntime.installation({ env });
  if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("the probe needs an installed hermes executable"); }
  if (installation.version !== HERMES_MCP_CREDENTIAL_RELEASE) {
    throw new Error(`this probe needs Hermes ${HERMES_MCP_CREDENTIAL_RELEASE} (the release OAR measured); this one reports ${installation.version ?? "no version"}`);
  }
  // `tools.tool_search` defers MCP tools behind the tool_call bridge; this profile keeps
  // every tool eager, which is what a host's model sees with the bridge switched off.
  writeFileSync(path.join(home, "config.yaml"), [
    "model:", "  provider: custom", "  base_url: PLACEHOLDER", "  api_key: oar-fake-key", "  default: oar-fake-model", "",
    "tools:", "  tool_search:", "    enabled: off", "",
  ].join("\n"));

  const provider = await startToolCallingProvider();
  try {
    writeFileSync(path.join(home, "config.yaml"), [
      "model:", "  provider: custom", `  base_url: ${provider.url}`, "  api_key: oar-fake-key", "  default: oar-fake-model", "",
      "tools:", "  tool_search:", "    enabled: off", "",
    ].join("\n"));

    // Generation one: a fresh session with the entry that carries it. The tool
    // answers without the value, so nothing but this process ever held it.
    const first = await hermesRuntime.session(installation, { cwd: root, env, mcpServers: [entry(generationOne)] });
    current.session = first;
    const firstText = await prompt(first, "call the probe tool");
    const firstRecordsHoldValue = holds(first, generationOne);
    const firstSessionId = first.id;
    await first.dispose();
    current.session = null;

    // Generation two: the same conversation, reopened by a new viewer.
    // The second prompt asks the tool to echo its value: OAR's records must
    // redact it, and Hermes' own transcript stores the tool's answer as any
    // other tool output.
    const second = await hermesRuntime.session(installation, { cwd: root, env, resume: firstSessionId, mcpServers: [entry(generationTwo)] });
    current.session = second;
    const secondText = await prompt(second, "call the probe tool and echo the value");
    const secondRecordsHoldValue = holds(second, generationTwo);
    await second.dispose();
    current.session = null;

    const starts = startedWith();
    const generations = [...new Set(starts)];
    process.stdout.write(`${JSON.stringify({
      installation: { kind: installation.kind, via: installation.via, version: installation.version },
      toolProcessStarts: starts,
      eachGenerationRanTheToolProcess: generations.join("|") === [generationOne, generationTwo].join("|"),
      mcpEvents: observations().map((observation) => String(observation.event)),
      toolsOfferedToTheModel: provider.offeredToolNames().map((names) => names.filter((name) => name.includes("probe"))),
      toolArguments: observations().filter((observation) => observation.event === "tools/call").map((observation) => observation.argument),
      firstTurnText: firstText.replaceAll(generationOne, "<generation-one>"),
      resumedTurnText: secondText.replaceAll(generationTwo, "<generation-two>"),
      credentialInOarRecords: { generationOne: firstRecordsHoldValue, generationTwo: secondRecordsHoldValue },
      credentialPersistedAfterATurnTheToolDidNotEcho: persistedValues(generationOne),
      filesHoldingTheValueAfterTheToolEchoedIt: persistedValues(generationTwo),
      homeFiles: filesUnder(home).length,
    }, null, 2)}\n`);

    if (generations.join("|") !== [generationOne, generationTwo].join("|")) {
      throw new Error("the tool process did not run under each generation's values in turn");
    }
    if (firstRecordsHoldValue || secondRecordsHoldValue) { throw new Error("a value reached OAR's records"); }
    // The first turn's tool answered without the value: nothing the daemon keeps may hold it then.
    // Generation two's echo is tool OUTPUT, which Hermes stores as transcript text like any other;
    // the credential itself is still only ever in the owner's memory.
    if (persistedValues(generationOne).length > 0) { throw new Error("the credential was persisted under HERMES_HOME"); }
  } finally {
    await provider.close();
  }
} finally {
  await current.session?.dispose().catch(() => {});
  await stopGateway().catch(() => {});
  // OAR_HERMES_KEEP_SCRATCH=1 keeps the temporary home for inspection.
  if (process.env.OAR_HERMES_KEEP_SCRATCH === undefined) { rmSync(root, { recursive: true, force: true }); }
  else { process.stderr.write(`kept ${root}\n`); }
}
