import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { opencodeRuntime, type AvailableInstallation, type SessionOptions } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { acpBackend } from "../../sea-trial/harness/acp-backends.js";
import { opencodePreparation } from "../../sea-trial/harness/opencode-home.js";

async function agent(installation: AvailableInstallation, options: SessionOptions, worker: number): Promise<number> {
  let failures = 0;
  for (let round = 1; round <= 18; round += 1) {
    const emit = (stage: string): void => { process.stdout.write(`AGENT worker=${worker} round=${round} stage=${stage}\n`); };
    emit("opening");
    try {
      // oxlint-disable-next-line no-await-in-loop -- each agent owns sequential sessions against the same durable user state.
      const session = await opencodeRuntime.session(installation, options);
      try {
        emit("opened");
        // oxlint-disable-next-line no-await-in-loop -- send one ordinary request to the scripted provider.
        const response = await session.prompt("a slow reply please");
        assert.equal(response.response.body.kind, "accepted");
        if (worker === 1 || round % 2 === 0) {
          // oxlint-disable-next-line no-await-in-loop -- completed turns write history before exit.
          const outcome = await awaitTurnEnd(session, response.seq);
          assert.equal(outcome.kind, "completed");
        } else {
          // oxlint-disable-next-line no-await-in-loop -- vary when one agent stops a live turn as another opens.
          await delay((round % 5) * 100);
        }
      } finally {
        emit("disposing");
        // oxlint-disable-next-line no-await-in-loop -- each agent waits for its own disposal before its next open.
        await session.dispose();
      }
      emit("done");
    } catch (error) {
      failures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      emit(detail.includes("Standalone server exited before reporting readiness") ? "readiness_failure" : "other_failure");
    }
  }
  return failures;
}

const fixture = await acpBackend("opencode");
try {
  const installation = await opencodeRuntime.installation();
  assert.ok(installation.kind === "available" && installation.via === "executable" && installation.version?.includes("2.2.7") === true);
  const { env } = fixture.aimock;
  assert.ok(typeof env.HOME === "string" && typeof env.XDG_DATA_HOME === "string");
  const separate = process.env.OAR_EXPERIMENT_LAYOUT === "separate";
  const first = { cwd: join(env.HOME, "project-a"), env };
  const second = { cwd: join(env.HOME, "project-b"), env: separate ? { ...env, XDG_DATA_HOME: join(env.HOME, "second-data") } : env };
  await Promise.all([mkdir(first.cwd), mkdir(second.cwd)]);
  await fixture.beforeSuite?.(installation);
  if (separate) { await opencodePreparation(second.env)(installation); }
  const counts = await Promise.all([agent(installation, first, 1), agent(installation, second, 2)]);
  process.stdout.write(`AGENT layout=${separate ? "separate" : "shared"} failures=${counts.join(",")}\n`);
  if (counts.some(value => value > 0)) { process.exitCode = 1; }
} finally { await fixture.aimock.stop(); }
