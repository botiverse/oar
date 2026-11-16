/** Explicitly authorized real-account probe: one local run, with both native steer acknowledgments retained. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CursorSdk } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const [sdkDirectory, output] = process.argv.slice(2);
assert.ok(sdkDirectory !== undefined && output !== undefined, "native-steer.ts <installed SDK directory> <output directory>");
await mkdir(output, { recursive: true });
const manifestText = await readFile(path.join(sdkDirectory, "package.json"), "utf8");
const manifest = asRecord(parseJson(manifestText));
assert.equal(manifest?.version, "1.4.0");
// oxlint-disable-next-line typescript/no-unsafe-assignment -- The companion compile probe checks this supplied native module against CursorSdk.
const sdk: CursorSdk = await import(pathToFileURL(path.resolve(sdkDirectory, "dist/esm/index.js")).href);
const cwd = await mkdtemp(path.join(tmpdir(), "oar-cursor-steer-"));
const model = "gpt-5.4-nano";
const agent = await sdk.Agent.create({ model: { id: model }, local: { cwd, settingSources: [], sandboxOptions: { enabled: false } } });
const tool = Promise.withResolvers<void>();
const deadline = Promise.withResolvers<never>();
const timer = setTimeout(() => { deadline.reject(new Error("native steer probe exceeded 120 seconds")); }, 120_000);
const raw = path.join(output, "native.jsonl");
const started = Date.now();
let toolCompleted = false;
let toolId: unknown = null;
const run = await agent.send("Use the shell tool once to run `sleep 8; echo ALPHA`. After it finishes, reply with ALPHA plus any short word I ask you to append. Do not read files or run other tools.", {
  onDelta({ update }) {
    appendFileSync(raw, `${JSON.stringify({ elapsedMs: Date.now() - started, update })}\n`);
    const delta = asRecord(update);
    if (delta?.type === "tool-call-started" && toolId === null) { toolId = delta.callId; tool.resolve(); }
    if (delta?.type === "tool-call-completed" && delta.callId === toolId) { toolCompleted = true; }
  },
});
try {
  assert.ok(run.steer !== undefined);
  await Promise.race([tool.promise, deadline.promise, run.wait().then(() => { throw new Error("run ended without the requested tool"); })]);
  const duringTool = !toolCompleted;
  const delivered = await Promise.race([run.steer("Append MANGO."), deadline.promise]);
  const result = await Promise.race([run.wait(), deadline.promise]);
  const handback = await Promise.race([run.steer("AFTER_END"), deadline.promise]);
  const terminal = asRecord(result);
  const summary = { sdk: manifest.version, model, platform: process.platform, duringTool, delivered, handback, result: terminal?.result, status: terminal?.status, usage: terminal?.usage, elapsedMs: Date.now() - started };
  await writeFile(path.join(output, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(duringTool, true);
  assert.equal(delivered, "complete_delivered");
  assert.equal(handback, "revert_to_followup");
  assert.equal(terminal?.status, "finished");
  assert.match(String(terminal.result), /MANGO/u);
} finally {
  clearTimeout(timer);
  await run.cancel();
  agent.close();
  await rm(cwd, { recursive: true, force: true });
}
