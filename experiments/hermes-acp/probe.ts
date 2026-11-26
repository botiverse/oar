/* oxlint-disable import/max-dependencies -- One repeatable real-runtime probe composes the adapter, provider and public session API. */
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hermesRuntime } from "../../packages/oar/src/runtimes/hermes/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { startFakeProvider } from "./fake-provider.js";

/*
 * Repeatable Hermes evidence: the real `hermes acp` entry against a scripted
 * OpenAI-compatible provider, in a temporary HERMES_HOME. No login and no
 * tokens. The native ACP extra must already be installed:
 *
 *   hermes pm install --extra acp
 *   OAR_HERMES_BIN=/absolute/path/to/hermes pnpm tsx experiments/hermes-acp/probe.ts
 *
 * Set OAR_HERMES_PYTHONPATH when the `acp` package lives outside that
 * interpreter (a wheel on PYTHONPATH); it is forwarded to the child.
 * The output keeps no session id, account identifier or temporary path.
 */

const command = process.env.OAR_HERMES_BIN ?? "hermes";
const provider = await startFakeProvider();
const home = await mkdtemp(path.join(tmpdir(), "oar-hermes-probe-"));
const env: Record<string, string> = {
  OAR_HERMES_BIN: command,
  HERMES_HOME: home,
  ...(process.env.OAR_HERMES_PYTHONPATH === undefined ? {} : { PYTHONPATH: process.env.OAR_HERMES_PYTHONPATH }),
};

function records(session: Session): readonly string[] {
  return session.records().map((record) => record.kind === "frame"
    ? `${record.body.type}${record.body.events.length === 0 ? "" : `:${record.body.events.map((event) => event.kind).join(",")}`}`
    : `${record.kind}:${record.body.kind}`);
}

async function stopGateway(): Promise<void> {
  const child = spawn(command, ["gateway", "stop"], { env: { ...process.env, ...env }, stdio: "ignore" });
  await once(child, "exit");
}

try {
  await writeFile(path.join(home, "config.yaml"), [
    "model:",
    "  provider: custom",
    `  base_url: ${provider.url}`,
    "  api_key: oar-fake-key",
    "  default: oar-fake-model",
    "",
  ].join("\n"));

  // Phase timings: the gateway's own mount is native work OAR cannot remove, so
  // the numbers separate what OAR waits for from what OAR adds.
  const timings: Record<string, number> = {};
  const mark = (phase: string, started: number): void => { timings[phase] = Math.round(performance.now() - started); };
  let started = performance.now();
  const installation = await hermesRuntime.installation({ env });
  mark("installReadinessMs", started);
  if (installation.kind !== "available") {
    throw new Error(`Hermes installation is ${installation.kind}`);
  }
  started = performance.now();
  const session = await hermesRuntime.session(installation, { cwd: home, env });
  mark("openMs", started);
  const promptedAt = performance.now();
  const firstToken: { at: number | null } = { at: null };
  const stopWatching = session.events((event) => {
    if (firstToken.at === null && (event.kind === "text_delta" || event.kind === "reasoning")) {
      firstToken.at = Math.round(performance.now() - promptedAt);
    }
  });
  const turn = await promptAndWait(session, "say hello from OAR");
  stopWatching();
  if (firstToken.at !== null) { timings.firstTokenMs = firstToken.at; }
  timings.turnMs = Math.round(performance.now() - promptedAt);
  let missing: { readonly name: string; readonly message: string } | null = null;
  started = performance.now();
  try {
    await hermesRuntime.session(installation, { cwd: home, env, resume: "oar-missing-hermes-session" });
  } catch (error) {
    missing = { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) };
  }
  mark("missingResumeMs", started);
  // A resume of the live session: the gateway re-attaches instead of mounting.
  started = performance.now();
  const resumed = await hermesRuntime.session(installation, { cwd: home, env, resume: session.id });
  mark("resumeMs", started);
  timings.resumeModelSetters = resumed.records().filter((record) => record.kind === "frame" && record.body.type === "session/set_config_option").length;
  await resumed.dispose();
  // The catalog read opens its own gateway session; keep its cost separate.
  started = performance.now();
  await hermesRuntime.listModels(installation, { env });
  mark("listModelsMs", started);
  console.log(JSON.stringify({
    installation: { kind: installation.kind, via: installation.via, version: installation.via === "executable" ? installation.version : undefined },
    capabilities: session.capabilities,
    model: session.model().value,
    effort: session.effort().value,
    turn: { kind: turn.kind, outcome: turn.kind === "ended" ? turn.outcome : turn },
    text: turn.kind === "ended" ? turn.text : undefined,
    contextUsage: session.contextUsage().value,
    tokenTotal: session.usage().value.total,
    records: records(session),
    timings,
    missingResume: missing,
  }, null, 2));
  await session.dispose();
} finally {
  await stopGateway().catch(() => {});
  await provider.close();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
