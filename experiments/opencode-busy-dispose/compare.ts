import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { opencodeRuntime, type AvailableInstallation, type SessionOptions } from "../../packages/oar/src/index.js";
import { acpBackend } from "../../sea-trial/harness/acp-backends.js";
import { readStartupErrors } from "../../sea-trial/harness/opencode-startup-log.js";

const effort = "oar-no-such-effort";
type Arm = "overlap" | "after-exit";

async function checkEffort(installation: AvailableInstallation, options: SessionOptions): Promise<string> {
  try {
    const session = await opencodeRuntime.session(installation, { ...options, effort });
    try { return session.effort().value === effort ? "exact_effort" : "wrong_effort"; }
    finally { await session.dispose(); }
  } catch (error) {
    const message = String(error);
    if (message.includes(effort)) { return "effort_refused"; }
    if (message.includes("Standalone server exited before reporting readiness")) { return "readiness_exit"; }
    return error instanceof Error ? error.name : "unknown_failure";
  }
}

interface Prepared {
  readonly installation: AvailableInstallation;
  readonly data: string;
  readonly options: SessionOptions;
}

async function measure(arm: Arm, round: number, { installation, data, options }: Prepared): Promise<void> {
  const peer = await opencodeRuntime.session(installation, options);
  try {
    const accepted = await peer.prompt("please answer slow-ly");
    assert.equal(accepted.kind, "accepted");
    const disposing = Date.now();
    const exit = peer.dispose();
    // Both captured CI failures opened 297 to 316 ms after the peer started disposal.
    // Both arms use the same prepared database, prompt and scheduling point.
    await wait(300);
    if (arm === "after-exit") { await exit; }
    const open = Date.now();
    const outcome = await checkEffort(installation, options);
    const answered = Date.now();
    await exit;
    const end = peer.records().find(record => record.kind === "response" && record.body.kind === "exited");
    assert.ok(end !== undefined, "Peer disposal did not record an exit");
    const exited = end.receivedAt;
    const errors = await readStartupErrors(data, open, answered).catch(() => null);
    process.stdout.write(`${JSON.stringify({ arm, round, disposing, open, exited, answered, outcome, errors })}\n`);
  } finally { await peer.dispose(); }
}

const { aimock, beforeSuite } = await acpBackend("opencode");
try {
  const installation = await opencodeRuntime.installation();
  assert.ok(installation.kind === "available" && installation.via === "executable" && installation.version?.includes("2.2.7") === true);
  const data = aimock.env.XDG_DATA_HOME;
  assert.ok(data !== undefined && beforeSuite !== undefined);
  await beforeSuite(installation);
  const prepared = { data, installation, options: { cwd: process.cwd(), env: aimock.env } };
  const rounds = Number(process.argv[2] ?? 20);
  for (let round = 1; round <= rounds; round += 1) {
    const arms: Arm[] = round % 2 === 1 ? ["overlap", "after-exit"] : ["after-exit", "overlap"];
    for (const arm of arms) {
      // oxlint-disable-next-line no-await-in-loop -- Isolate each pair on the same prepared home.
      await measure(arm, round, prepared);
    }
  }
} finally { await aimock.stop(); }
