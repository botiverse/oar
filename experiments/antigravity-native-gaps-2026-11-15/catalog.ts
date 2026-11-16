import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { promptAndWait, antigravityRuntime } from "../../packages/oar/src/index.js";

import { ECHO_SERVER } from "../../sea-trial/vendor/support/echo-mcp.js";

const antigravitySession = antigravityRuntime.session;

const [binary, output] = process.argv.slice(2);
assert.ok(binary !== undefined && output !== undefined);
const fixture = await startAntigravityAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "NATIVE_GAPS_CATALOG_OK" }); });
const cwd = fixture.env.HOME;
assert.ok(cwd !== undefined);
const session = await antigravitySession({ kind: "available", via: "executable", command: resolve(binary) }, {
  cwd, env: fixture.env, model: "gemini-3.8-flash",
  mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER] }],
});
try {
  const result = await promptAndWait(session, "NATIVE_GAPS_CATALOG");
  await writeFile(output, JSON.stringify({ result, records: session.records(), provider: fixture.raw }, null, 2));
  console.log(JSON.stringify({ result, output, requests: fixture.raw.length }));
} finally { await session.dispose(); await fixture.stop(); }
