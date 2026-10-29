import { writeFile } from "node:fs/promises";
import { promptAndWait } from "../../packages/oar/src/index.js";
import { codebuddyInstallation } from "../../packages/oar/src/runtimes/codebuddy/installation.js";
import { codebuddySession } from "../../packages/oar/src/runtimes/codebuddy/session.js";
import { startCodebuddyAimock } from "../../sea-trial/harness/codebuddy-aimock.js";

const env = await startCodebuddyAimock();
const installation = await codebuddyInstallation();
if (installation.kind !== "available") { throw new Error(JSON.stringify(installation)); }
const evidence: unknown[] = [];
try {
  const session = await codebuddySession(installation, { cwd: env.cwd, env: env.env, model: "deepseek-flash" });
  try {
    for (const input of ["first local marker", "second local marker"]) {
      // oxlint-disable-next-line no-await-in-loop -- Consecutive prompts are the native boundary under investigation.
      const outcome = await promptAndWait(session, input, { timeoutMs: 45_000 });
      console.log(JSON.stringify({ input, outcome, usage: session.usage().value, model: session.model().value, requests: env.raw.length }));
      evidence.push({ outcome, records: session.records() });
    }
  } finally { await session.dispose(); }
  const resumed = await codebuddySession(installation, { cwd: env.cwd, env: env.env, model: "deepseek-flash", resume: session.id });
  try {
    const outcome = await promptAndWait(resumed, "after resume marker", { timeoutMs: 45_000 });
    console.log(JSON.stringify({ resumed: outcome, usage: resumed.usage().value, requests: env.raw.length }));
    evidence.push({ outcome, records: resumed.records() });
  } finally { await resumed.dispose(); }
} finally {
  await writeFile(process.env.OAR_PROBE_OUTPUT ?? "codebuddy-probe.json", JSON.stringify({ evidence, requests: env.raw }, null, 2));
  await env.stop();
}
