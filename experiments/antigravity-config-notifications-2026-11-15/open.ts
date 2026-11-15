/** Exercise the complete OAR open path using the newly reconstructed fake sample. */
/* oxlint-disable eslint/no-await-in-loop -- Separate transcripts for model and effort. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";

const [output, expected = "confirmed"] = process.argv.slice(2);
assert.ok(output !== undefined && output.length > 0, "usage: open.ts <output-prefix> [confirmed|refused]");
assert.ok(expected === "confirmed" || expected === "refused");
const relay = fileURLToPath(new URL("fake-relay.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-acp-agent.mjs", import.meta.url));
const results: unknown[] = [];
for (const configId of ["model", "thought_level"]) {
  const log = resolve(`${output}-${configId}.jsonl`);
  await writeFile(log, "");
  const open = acpSession({ ...antigravityAcpProfile, requestTimeoutMs: 3000, args: [relay, fixture, configId, log] });
  let failure: string | null = null;
  try {
    const session = await open({ kind: "available", via: "executable", command: process.execPath }, {
      cwd: process.cwd(), model: "requested-y", ...(configId === "thought_level" ? { effort: "high" } : {}),
    });
    assert.equal(session.model().value, "requested-y");
    if (configId === "thought_level") { assert.equal(session.effort().value, "high"); }
    await session.dispose();
  } catch (error) { failure = String(error); }
  if (expected === "refused") { assert.match(failure ?? "", /config_option_update left/u); }
  else { assert.equal(failure, null); }
  results.push({ configId, outcome: failure === null ? "confirmed" : "refused", ...(failure === null ? {} : { failure }) });
}
await writeFile(`${output}.json`, JSON.stringify({ evidenceKind: "new synthetic sample; original unavailable", results }, null, 2));
console.log(JSON.stringify(results));
