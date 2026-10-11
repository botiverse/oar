/* oxlint-disable no-await-in-loop -- Keep each native schema result beside its provider request. */
/** Raw Grok ACP outputSchema and validation. No account; a local scripted provider and temporary home.
 * Run: OAR_GROK_BIN=/absolute/grok pnpm tsx experiments/grok-structured-output-native.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpClient, startAcpProcess } from "../packages/oar/src/shared/acp/process.js";
import { openAcpSession, promptAcp } from "../packages/oar/src/shared/acp/profile.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { startGrokAimock } from "../sea-trial/harness/aimock-acp.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

for (const mode of ["valid", "invalid", "bad-schema"] as const) {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-schema-"));
  const provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: JSON.stringify({ answer: mode === "invalid" ? "wrong" : 4 }) }); });
  const app = createAcpClient({ name: "oar-schema-probe" });
  const args = typeof grokAcpProfile.args === "function" ? grokAcpProfile.args({ cwd: root }) : grokAcpProfile.args;
  const native = startAcpProcess(process.env.OAR_GROK_BIN ?? "grok", args, app, { cwd: root, env: { PATH: process.env.PATH, ...provider.env } });
  const timer = setTimeout(() => { native.kill(); }, 30_000);
  try {
    const opened = await openAcpSession(native, grokAcpProfile, { cwd: root });
    const outputSchema = mode === "bad-schema" ? { type: "not-a-type" } : { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
    const response = await promptAcp(native, opened.sessionId, [{ type: "text", text: "Give the answer" }], { _meta: { outputSchema } });
    assert.equal(response.stopReason, "end_turn");
    // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the native ACP extension envelope.
    const meta = asRecord(response._meta);
    if (mode === "valid") { assert.deepEqual(meta?.structuredOutput, { answer: 4 }); }
    else { assert.equal(typeof meta?.structuredOutputError, "string"); assert.ok(!Object.hasOwn(meta ?? {}, "structuredOutput")); }
    console.log(JSON.stringify({ mode, response, requests: provider.raw.map((request) => ({ format: asRecord(request.body)?.response_format, text: asRecord(request.body)?.text })) }).replaceAll(root, "<TMP>"));
  } finally { clearTimeout(timer); native.kill(); await native.exited; await provider.stop(); await rm(root, { recursive: true, force: true }); }
}
