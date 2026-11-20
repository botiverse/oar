import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeRuntime, type AvailableInstallation } from "../../packages/oar/src/index.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

interface Fixture {
  root: string;
  installation: AvailableInstallation;
  homes: readonly Readonly<Record<string, string>>[];
}

async function pair(round: number, { root, installation, homes }: Fixture): Promise<number> {
  const data = join(root, `pair-${String(round)}`);
  const db = join(data, "opencode", "opencode.db");
  await mkdir(data);
  assert.equal(existsSync(db), false);
  const opens = homes.map(async (env, index) => {
    const session = await opencodeRuntime.session(installation, {
      cwd: join(root, `project-${String(index)}`), env: { ...env, XDG_DATA_HOME: data },
    });
    return session;
  });
  const results = await Promise.allSettled(opens);
  try {
    const sessions = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    assert.equal(new Set(sessions.map(session => session.id)).size, sessions.length);
    const outcomes = results.map(result => {
      if (result.status === "fulfilled") { return "ready"; }
      return result.reason instanceof Error && result.reason.message.includes("Standalone server exited before reporting readiness") ? "readiness_exit" : "other_failure";
    });
    assert.equal(existsSync(db), true);
    process.stdout.write(`${JSON.stringify({ round, outcomes })}\n`);
    return sessions.length;
  } finally { await Promise.all(results.map(async result => { if (result.status === "fulfilled") { await result.value.dispose(); } })); }
}

const root = await mkdtemp(join(tmpdir(), "oar-opencode-public-pair-"));
const fixtures = await Promise.all([0, 1].map(async index => {
  await mkdir(join(root, `project-${String(index)}`));
  return startOpencodeAimock(() => {});
}));
try {
  const installation = await opencodeRuntime.installation();
  assert.ok(installation.kind === "available" && installation.via === "executable" && installation.version?.includes("2.2.7") === true);
  const rounds = Number(process.argv[2] ?? "20");
  const fixture = { root, installation, homes: fixtures.map(backend => backend.env) };
  let ready = 0;
  for (let round = 1; round <= rounds; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Two public calls overlap within a pair; each new pair starts cold.
    ready += await pair(round, fixture);
  }
  process.stdout.write(`${JSON.stringify({ platform: process.platform, rounds, ready, failed: rounds * 2 - ready })}\n`);
} finally {
  await Promise.all(fixtures.map(async fixture => { await fixture.stop(); }));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
