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

  const installation = await hermesRuntime.installation({ env });
  if (installation.kind !== "available") {
    throw new Error(`Hermes installation is ${installation.kind}`);
  }
  const session = await hermesRuntime.session(installation, { cwd: home, env });
  const turn = await promptAndWait(session, "say hello from OAR");
  let missing: { readonly name: string; readonly message: string } | null = null;
  try {
    await hermesRuntime.session(installation, { cwd: home, env, resume: "oar-missing-hermes-session" });
  } catch (error) {
    missing = { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) };
  }
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
    missingResume: missing,
  }, null, 2));
  await session.dispose();
} finally {
  await stopGateway().catch(() => {});
  await provider.close();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
