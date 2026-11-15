import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promptAndWait } from "../../packages/oar/src/observe/index.js";
import { bootstrapCompaction } from "../../sea-trial/vendor/support/pi-bootstrap.js";
import { until } from "../../sea-trial/vendor/support/pi-input-disposition.js";

const backend = process.env.OAR_TEST;
assert.ok(backend === "pi-aimock" || backend === "pi-rpc-aimock", "Set OAR_TEST to pi-aimock or pi-rpc-aimock");
const output = path.resolve(process.argv[2] ?? "oar-trial-run/pi-bootstrap-admission");
const f = await bootstrapCompaction();
const exited = (): boolean => f.session.records().some(record => record.kind === "response" && record.body.kind === "exited");
const before = f.session.status().value;
const started = performance.now();
let response: unknown = "pending";
let responseMs: number | null = null;
async function observePrompt(): Promise<void> {
  try { const result = await f.session.prompt("D"); response = result.response.body; }
  catch (error) { response = { rejectedPromise: String(error) }; }
  responseMs = performance.now() - started;
}
function requestLabel(text: string): string {
  if (text.startsWith("BOOT ")) { return "BOOT"; }
  return text.startsWith("# Conversation") ? "COMPACTION" : text;
}
// oxlint-disable-next-line unicorn/prefer-top-level-await -- Observe a possibly unresolved prompt while releasing the native hook below.
const pending = observePrompt();
try {
  // Give RPC's stdin command time to reach the held native settlement hook.
  // The hook itself is held by a file gate, not by this delay.
  await sleep(100);
  await f.release();
  assert.ok(await f.compacted(), "Native compaction must finish");
  await until(() => response !== "pending", backend === "pi-rpc-aimock" ? 33_000 : 2000);
  if (backend === "pi-rpc-aimock") { await until(exited, 5000); }
  const next = response === "pending" ? "not submitted: D still unresolved" : await promptAndWait(f.session, "NEXT");
  await mkdir(output, { recursive: true });
  const summary = { backend, before, response, responseMs, after: f.session.status().value, exited: exited(),
    hooks: await f.hooks(), modelRequests: f.requests.map(requestLabel), next };
  await writeFile(path.join(output, `${backend}.json`), `${JSON.stringify({ summary, records: f.session.records() }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ backend, before, response, responseMs, exited: exited(), next: typeof next === "string" ? next : next.kind })}\n`);
} finally { await f.close(); void pending; }
