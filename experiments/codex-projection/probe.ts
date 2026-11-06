import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { promptAndWait, codexInstallation, codexSession } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";
import { codexMessageReply } from "../../sea-trial/vendor/support/codex-messages.js";

const snapshot = await codexInstallation();
assert.ok(snapshot.kind === "available");
assert.ok(snapshot.via === "executable");
const installation = snapshot;
async function probe(mode: "completed-only" | "streamed" | "unauthorized"): Promise<unknown> {
  const env = await startCodexAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, { content: "COMPLETE_TEXT" });
  }, {
    rewriteResponse: (body) => {
      if (!body.startsWith("event:") && !body.startsWith("data:")) { return body; }
      if (mode === "unauthorized") {
        return `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: {
          id: "resp_auth", status: "failed", output: [], error: { code: "unauthorized", message: "synthetic authorization refusal" },
        } })}\n\n`;
      }
      return codexMessageReply(body, mode === "streamed", "final_answer");
    },
  });
  try {
    assert.ok(env.env !== undefined && typeof env.env.CODEX_HOME === "string" && env.env.CODEX_HOME.length > 0);
    await appendFile(path.join(env.env.CODEX_HOME, "config.toml"), "request_max_retries = 0\nstream_max_retries = 0\n");
    const session = await codexSession(installation, { cwd: process.cwd(), env: env.env, model: "gpt-5.1" });
    try {
      const outcome = await promptAndWait(session, "Say the marker.", { timeoutMs: 30_000 });
      const frames = session.records().flatMap(record => {
        if (record.kind !== "frame") { return []; }
        const native = asRecord(record.body.native);
        const item = asRecord(native?.item);
        if (item?.type === "agentMessage" || record.body.type === "item/agentMessage/delta" || record.body.type === "turn/completed" || record.body.type === "error") {
          return [{ type: record.body.type, native, events: record.body.events }];
        }
        return [];
      });
      return { mode, outcome, frames };
    } finally { await session.dispose(); }
  } finally { await env.stop(); }
}
const results = await Promise.all([probe("completed-only"), probe("streamed"), probe("unauthorized")]);
console.log(JSON.stringify({ version: installation.version, results }, null, 2));
