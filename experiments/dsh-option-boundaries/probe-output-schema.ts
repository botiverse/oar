import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshEnvironment, launchDsh } from "../../packages/oar/src/runtimes/dsh/launch.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { say, untilCount, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { durableEvents, lastInput, toolResults } from "../../sea-trial/vendor/support/dsh-provider.js";

const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-output-schema.json");
const root = "11111111-1111-4111-8111-111111111111";
await withDshFixture((request) => {
  if (lastInput(request).includes("CHILD_SCHEMA")) {
    return { kind: "tool", name: "structured_output", arguments: { answer: 42 } };
  }
  if (lastInput(request).includes("CALL_CHILD") && toolResults(request) === 0) {
    return { kind: "tool", name: "schema_probe_child", arguments: {} };
  }
  return say("not a JSON object");
}, async ({ installation, aimock, provider, open }) => {
  const publicFailure = await open({ outputSchema: schema }).catch((error: unknown) => error);
  assert.equal(asRecord(publicFailure)?.option, "outputSchema");
  assert.equal(provider.requests.length, 0);
  const plugin = path.join(aimock.cwd, "schema-probe.mjs");
  await writeFile(plugin, `export const inject = ["tools", "subagents"];
export function apply(ctx) {
  ctx.tools.register({
    name: "schema_probe_child", description: "Native structured child control",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const child = await ctx.subagents.startActivation({
        provider: "spawn", label: "schema control", delivery: "caller", signal: exec.signal,
        request: { parent: exec.agent, prompt: [{ type: "text", text: "CHILD_SCHEMA" }], outputSchema: ${JSON.stringify(schema)} }
      });
      try { return await child.result; } finally { await child.dispose(); }
    }
  });
}`);
  const patch = path.join(aimock.home, "cordis.patch.yml");
  const rows: unknown = JSON.parse(await readFile(patch, "utf8"));
  await writeFile(patch, JSON.stringify([...asRecordList(rows), { insert: [{ id: "schema-probe", name: pathToFileURL(plugin).href }] }]));
  assert.ok(installation.via === "executable");
  const { child, directory } = await launchDsh(installation.command, aimock.cwd, dshEnvironment(aimock.env));
  const frames: JsonRecord[] = [];
  const control = dshControl(child, (frame) => { frames.push(frame); });
  const ends = (): number => frames.filter((frame) => frame.sessionId === root && asRecord(frame.event)?.type === "turn/end").length;
  try {
    await control.ready;
    const opened = await control.request("open", { sessionId: root, cwd: aimock.cwd, agentOptions: { outputSchema: schema } });
    await control.request("prompt", { sessionId: root, text: "ROOT_SCHEMA" });
    await untilCount(ends, 1);
    assert.equal(ends(), 1);
    const [first] = provider.requests;
    assert.ok(first !== undefined);
    assert.equal(JSON.stringify(first.body.tools).includes('"name":"structured_output"'), false);
    assert.equal(first.body.response_format, undefined);
    await control.request("prompt", { sessionId: root, text: "CALL_CHILD" });
    await untilCount(ends, 2, 30_000);
    assert.equal(ends(), 2);
    await control.request("dispose");
    const log = await durableEvents(aimock.home, root);
    const childRequest = provider.requests.find((request) => lastInput(request).includes("CHILD_SCHEMA"));
    assert.ok(childRequest !== undefined);
    assert.ok(JSON.stringify(childRequest.body.tools).includes('"name":"structured_output"'));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ installation, publicFailure: String(publicFailure), opened, requests: provider.requests, frames, log }, null, 2));
    const childResult = provider.requests.flatMap((request) => request.messages).find((message) => message.role === "tool");
    assert.ok(typeof childResult?.content === "string");
    const parsed: unknown = JSON.parse(childResult.content);
    assert.deepEqual(asRecord(parsed)?.structured, { answer: 42 });
    assert.equal(asRecord(parsed)?.stopReason, "completed");
    const ended = asRecord(log.find((event) => event.type === "turn/end")?.data);
    assert.equal(asRecord(ended?.reason)?.kind, "completed");
    console.log(JSON.stringify({ output, publicRefusal: true, rootSchemaIgnored: true, childSchemaApplied: true, requests: provider.requests.length }));
  } finally { child.kill(); await child.exited; directory.remove(); }
});
