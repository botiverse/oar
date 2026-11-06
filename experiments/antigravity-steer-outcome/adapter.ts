/* oxlint-disable eslint/max-statements, typescript/promise-function-async, import/max-dependencies -- Compare provider, native wire and public OAR outcomes in one bounded probe. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { antigravityAcpProfile, antigravityAcpArgs } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { bounded, killOwnedWorker } from "./support.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";

const mode = process.argv[2] ?? "refusal";
assert.ok(mode === "refusal" || mode === "worker-exit");
const command = process.env.OAR_ANTIGRAVITY_BIN;
assert.ok(command !== undefined);
const directory = path.resolve(process.argv[3] ?? "oar-trial-run/antigravity-steer-outcome");
await mkdir(directory, { recursive: true });
const model = Promise.withResolvers<void>(), originalAnswered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    if (JSON.stringify(request.messages).includes("You are a conversation title generator")) { return { content: "Probe" }; }
    model.resolve(); await release.promise;
    return { content: "AGY_ORIGINAL_COMPLETED" };
  });
});
const home = fixture.env.HOME; assert.ok(home !== undefined);
const image = path.join(home, "empty.png"); await writeFile(image, "");
const pidFile = path.join(directory, `adapter-${mode}.pid`), traceFile = path.join(directory, `adapter-${mode}.jsonl`);
await writeFile(traceFile, "");
const relay = fileURLToPath(new URL("relay.mjs", import.meta.url));
const session = await acpSession({ ...antigravityAcpProfile, args: [relay, command, ...antigravityAcpArgs()] })(
  { kind: "available", via: "executable", command: process.execPath, version: "1.5.0" },
  { cwd: home, env: { ...fixture.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1", OAR_AGY_PROBE_PID_FILE: pidFile, OAR_AGY_PROBE_TRACE: traceFile, OAR_AGY_PROBE_DELAY_STEER: mode === "refusal" ? "1" : "0" } });
try {
  session.rawEvents(record => { if (record.kind === "frame" && record.body.type === "session/prompt") { originalAnswered.resolve(); } });
  const original = await session.prompt("AGY_ORIGINAL_OUTCOME");
  await bounded(model.promise);
  const steering = await session.steer?.("AGY_ACCEPTED_STEER", { inputId: "c6c6c6c6-c6c6-46c6-86c6-c6c6c6c6c6c6", ...(mode === "refusal" ? { images: [{ path: image }] } : {}) });
  if (mode === "worker-exit") {
    await bounded(originalAnswered.promise);
    const pid = Number(await readFile(pidFile, "utf8"));
    killOwnedWorker(pid);
  } else { release.resolve(); }
  const outcome = await bounded(awaitTurnEnd(session, original.request.seq));
  const result = { mode, steerAccepted: steering?.kind, outcome, status: session.status().value,
    frames: session.records().flatMap(record => record.kind === "frame" && record.body.type.startsWith("session/prompt") ? [{ seq: record.seq, ...record.body }] : []) };
  await writeFile(path.join(directory, `adapter-${mode}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { release.resolve(); await session.dispose(); await fixture.stop(); }
