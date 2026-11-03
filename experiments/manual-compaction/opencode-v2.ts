/* oxlint-disable eslint/no-await-in-loop -- Native scenarios and their records are intentionally sequential. */
/** Native ACP compaction and same-name command control, isolated synthetic provider. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { opencodeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const [output] = process.argv.slice(2);
assert.ok(output !== undefined, "provide a JSON output path");

const results: unknown[] = [];
for (const shadowed of [false, true]) {
  const fixture = await startOpencodeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, { content: `## Objective\nPreserve the controlled conversation history.\n## Work State\n${"A local synthetic conversation was summarized. ".repeat(80)}` });
  }, shadowed ? { commands: { compact: { description: "A user-defined compact command", template: "OAR_SHADOW_COMPACT_9173" }, "oar-proof": { description: "OAR_COMMAND_CONFIGURATION_LOADED", template: "OAR_ORDINARY_COMMAND" } } } : {});
  const holder: { request?: Parameters<NonNullable<AcpSessionProfile["configureSession"]>>[0]["request"] } = {};
  const start = acpSession({ ...opencodeV2AcpProfile, configureSession: async (opened) => { holder.request = opened.request; await Promise.resolve(); } });
  const installation = await opencodeRuntime.installation();
  assert.equal(installation.kind, "available");
  const session = await start(installation, { cwd: fixture.env.HOME ?? "", env: fixture.env });
  try {
    for (const input of ["SEED_ONE", "SEED_TWO"]) { const seeded = await promptAndWait(session, input, { timeoutMs: 30_000 }); assert.equal(seeded.kind, "ended"); }
    const seq = session.records().at(-1)?.seq ?? -1;
    assert.ok(holder.request);
    const native = await holder.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "/compact" }] });
    const updates = session.records().flatMap((record) => record.kind === "frame" && record.seq > seq ? [asRecord(record.body.native)?.update] : []);
    const markers = updates.flatMap((update) => {
      const value = asRecord(update);
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension metadata.
      const marker = asRecord(asRecord(value?._meta)?.["opencode/compaction"]);
      if (marker !== null) { return [marker]; }
      return value?.sessionUpdate === "compaction_update" ? [value] : [];
    });
    const customExecuted = fixture.raw.some((raw) => JSON.stringify(raw.body).includes("OAR_SHADOW_COMPACT_9173"));
    const compactCommand = session.records().flatMap((record) => {
      if (record.kind !== "frame") { return []; }
      const update = asRecord(asRecord(record.body.native)?.update);
      return update?.sessionUpdate === "available_commands_update" ? [update] : [];
    });
    console.log(JSON.stringify({ shadowed, native, markers, customExecuted }));
    await writeFile(output, `${JSON.stringify({ version: "2.2.5", results: [...results, { shadowed, native, markers, compactCommand, customExecuted }] }, null, 2)}\n`);
    assert.equal(customExecuted, false);
    if (shadowed) { assert.ok(JSON.stringify(compactCommand).includes("OAR_COMMAND_CONFIGURATION_LOADED"), "the native catalog must prove the user command configuration was loaded"); }
    assert.deepEqual(markers.map((marker) => marker.status), ["started", "completed"]);
    assert.equal(markers[0]?.messageId, markers[1]?.messageId);
    results.push({ shadowed, native, markers, compactCommand, customExecuted });
    console.log(JSON.stringify({ shadowed, native, markers, customExecuted }));
  } finally { await session.dispose(); await fixture.stop(); }
}
await writeFile(output, `${JSON.stringify({ version: "2.2.5", results }, null, 2)}\n`);
