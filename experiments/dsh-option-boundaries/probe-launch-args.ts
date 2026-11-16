import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshEnvironment } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { say, untilCount, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import type { ProviderRequest } from "../../sea-trial/vendor/support/dsh-provider.js";
import { launchProbe } from "./launch.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-launch-args.json");
const root = "22222222-2222-4222-8222-222222222222";
const results: unknown[] = [];
function system(request: ProviderRequest | undefined): string {
  assert.ok(request !== undefined);
  return request.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => String(message.content)).join("\n");
}
await withDshFixture(() => say("ok"), async ({ aimock, installation, provider, open }) => {
  assert.equal(installation.via, "executable");
  const plugin = path.join(aimock.cwd, "host-prompt.mjs");
  const overlay = path.join(aimock.cwd, "host-patch.json");
  await writeFile(plugin, `export const inject = ["systemPrompt"]; export function apply(ctx, config) {
    ctx.systemPrompt.section({ name: "fixture:host-launch", order: 999, text: config.text, complete: true, interpolate: false });
  }`);
  const publicFailure = await open({ launchArgs: ["--patch", overlay] }).catch((error: unknown) => error);
  assert.equal(asRecord(publicFailure)?.option, "launchArgs");
  assert.equal(provider.requests.length, 0);
  for (const [index, text] of ["FIRST {{literal}}", "RESUMED {{literal}}", null].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Each process resumes the durable session from the preceding one.
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: "fixture-host-launch", name: pathToFileURL(plugin).href, config: { text } }] }]));
    const args = text === null ? [] : ["--patch", overlay];
    // oxlint-disable-next-line no-await-in-loop -- One native process at a time owns this session.
    const { child, directory } = await launchProbe(installation.command, aimock.cwd, { env: dshEnvironment(aimock.env), args });
    const frames: JsonRecord[] = [];
    const control = dshControl(child, (frame) => { frames.push(frame); });
    try {
      // oxlint-disable-next-line no-await-in-loop -- Native commands are ordered, including readiness and shutdown.
      await (async (): Promise<void> => {
        await control.ready;
        await control.request(index === 0 ? "open" : "resume", { sessionId: root, cwd: aimock.cwd, agentOptions: {} });
        await control.request("prompt", { sessionId: root, text: `turn ${String(index)}` });
        const ends = (): number => frames.filter((frame) => asRecord(frame.event)?.type === "turn/end").length;
        await untilCount(ends, 1);
        assert.equal(ends(), 1);
        await control.request("dispose");
      })();
      assert.equal(provider.requests.length, index + 1);
      const observed = system(provider.requests[index]);
      if (text === null) { assert.ok(!observed.includes("{{literal}}")); }
      else { assert.equal(observed, text); }
      results.push({ index, frames });
    } finally { child.kill(); /* oxlint-disable-next-line no-await-in-loop -- Cleanup before the next native process. */ await child.exited; directory.remove(); }
  }
  const { child, directory } = await launchProbe(installation.command, aimock.cwd, { env: dshEnvironment(aimock.env), args: ["--patch", path.join(aimock.cwd, "missing.json")] });
  const control = dshControl(child, () => {});
  const failure = await control.ready.catch((error: unknown) => error);
  child.kill(); await child.exited; directory.remove();
  assert.match(String(failure), /DSH exited \(1\).*failed to read overlay/su);
  assert.equal(provider.requests.length, 3);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ publicFailure: String(publicFailure), results, requests: provider.requests, missingOverlayFailure: String(failure) }, null, 2));
});
console.log(JSON.stringify({ output, sequences: 3 }));
