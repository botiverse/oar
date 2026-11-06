import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";
import { codexTaskRecipient, codexTaskRequest } from "../sea-trial/vendor/support/codex-task-request.js";

// oxlint-disable-next-line eslint/max-statements, eslint/max-lines-per-function -- The concurrent HTTP regression retains all three original bodies and replies.
test("concurrent parent and child requests keep their own recipients through aimock normalization", async () => {
  const arrived = Promise.withResolvers<void>();
  let calls = 0;
  const provider = await startCodexAimock(mock => {
    mock.on({ predicate: () => true }, async request => {
      calls += 1;
      if (calls === 3) { arrived.resolve(); }
      await arrived.promise;
      return { content: String(codexTaskRecipient(request)) };
    });
  }, { warmHome: false, rewriteRequest: codexTaskRequest });
  try {
    const home = provider.env?.CODEX_HOME; assert.ok(home !== undefined);
    const config = await readFile(path.join(home, "config.toml"), "utf8");
    const base = /^base_url = "(?<url>[^"]+)"$/mu.exec(config)?.groups?.url; assert.ok(base !== undefined);
    const recipients = ["/root", "/root/a", "/root/b"];
    const bodies = recipients.map(recipient => ({ model: "fixture", stream: false, input: recipient === "/root" ? [{ role: "user", content: "TASK_ROOT" }] : [{ type: "agent_message", recipient, content: [] }] }));
    const replies = await Promise.all(bodies.map(async body => {
      const response = await fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      const result: unknown = await response.json();
      const output = asRecord(result)?.output; assert.ok(Array.isArray(output));
      const content = asRecord(output[0])?.content; assert.ok(Array.isArray(content));
      return asRecord(content[0])?.text;
    }));
    expect(replies).toEqual(recipients);
    expect(provider.raw).toHaveLength(3);
    expect(provider.raw.map(item => item.body)).toEqual(expect.arrayContaining(bodies));
  } finally { arrived.resolve(); await provider.stop(); }
});
