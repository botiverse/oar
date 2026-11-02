/* oxlint-disable eslint/no-await-in-loop -- Native scenarios and their records are intentionally sequential. */
/** Native stream-json command identity and cancellation controls. */
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { qoderRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const [output] = process.argv.slice(2); assert.ok(output !== undefined);
const results: unknown[] = [];
for (const scenario of ["completed", "cancelled", "empty", "shadowed"] as const) {
  const fixture = await startQoderNative(Array.from({ length: 12 }, () => ({ text: `OAR_MANUAL_SUMMARY ${"Preserve the conversation's facts. ".repeat(80)}`, input: 10_000, output: 1000 })), scenario === "cancelled" ? 500 : 1);
  if (scenario === "shadowed") {
    const commands = path.join(fixture.options.cwd, ".qoder", "commands");
    await mkdir(commands, { recursive: true });
    await writeFile(path.join(commands, "compact.md"), "Reply only OAR_SHADOW_COMPACT.");
    await writeFile(path.join(commands, "oar-proof.md"), "Reply only OAR_COMMAND_CONFIGURATION_LOADED.");
  }
  const installation = await qoderRuntime.installation(); assert.ok(installation.kind === "available" && installation.via === "executable");
  const session = await qoderRuntime.session(installation, { ...fixture.options, model: "efficient" });
  try {
    if (scenario !== "empty") {
      for (const input of ["OAR_SEED_ONE", "OAR_SEED_TWO"]) { const seeded = await promptAndWait(session, input, { timeoutMs: 30_000 }); assert.equal(seeded.kind, "ended"); }
    }
    const commandLoaded = JSON.stringify(session.records()).includes("oar-proof");
    if (scenario === "shadowed") { assert.ok(commandLoaded, "the native catalog must prove the user command configuration was loaded"); }
    const from = session.records().length;
    const compacting = Promise.withResolvers<void>();
    const unsubscribe = session.rawEvents((record) => {
      if (record.kind === "frame") { const native = asRecord(record.body.native); if (native?.type === "system" && native.subtype === "status" && native.status === "compacting") { compacting.resolve(); } }
    });
    let abort: unknown = null;
    const waiting = promptAndWait(session, "/compact", { timeoutMs: 30_000 });
    if (scenario === "cancelled") { await Promise.race([compacting.promise, (async (): Promise<never> => { await sleep(20_000, undefined, { ref: false }); throw new Error("No native compacting status"); })()]); abort = await session.abort(); }
    const answer = await waiting;
    await sleep(100);
    unsubscribe();
    const frames = session.records().slice(from).flatMap((record) => {
      if (record.kind !== "frame") { return []; }
      const native = asRecord(record.body.native);
      if (native?.type === "command_lifecycle" || native?.type === "result" || (native?.type === "system" && (native.subtype === "status" || native.subtype === "compact_boundary"))) { return [{ type: record.body.type, native, events: record.body.events }]; }
      return [];
    });
    const result = { abort, commandLoaded, version: installation.version, scenario, outcome: answer.kind === "ended" ? answer.outcome : answer.kind, frames };
    results.push(result); console.log(JSON.stringify(result));
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
  } finally { await session.dispose(); await fixture.stop(); }
}
