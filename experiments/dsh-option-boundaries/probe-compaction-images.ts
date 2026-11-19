import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { say, untilCount, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { withNativeProbe } from "./native-probe.js";

const mode = process.argv[2] ?? "manual";
const output = process.argv[3] ?? "oar-trial-run/dsh-content.json";
const id = randomUUID();
const commandId = randomUUID();
const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const source = `async probe(request) {
  const { agent } = owned(request.sessionId);
  if (request.image) {
    const attachments = ctx.get("attachments");
    const route = await ctx.get("llm").resolveModelInfo("aimock", "aimock-model");
    const refs = await attachments.saveImages([{ mediaType: "image/png", data: Buffer.from(request.image, "base64") }]);
    agent.followup({ id: randomUUID(), role: "user", content: [{type:"text",text:"IMAGE_CONTROL"}, {type:"image",attachment:refs[0]}], source:{kind:"user"} });
    return { modalities: route.inputModalities, types: attachments.imageLimits.mediaTypes };
  }
  return { result: await ctx.get("compaction").compactNow(agent, new AbortController().signal, request.commandId) };
},`;
const result: Record<string, unknown> = {};
try {
  await withDshFixture(() => say("Keep the two source facts in the summary."), async fixture => {
    result.version = fixture.installation.via === "executable" ? fixture.installation.version : null;
    const config = { auto: mode === "auto", thresholdRatio: 0.2, headroomTokens: 128, retainTokens: 200, maxTokens: 1024 };
    await withNativeProbe(fixture, { source, rows: [{ id: "compaction-basic", config }] }, async (control, frames) => {
      await control.request("open", { sessionId: id, cwd: fixture.aimock.cwd, agentOptions: { provider: "aimock", model: "aimock-model" } });
      const idle = (): number => frames.filter(frame => frame.sessionId === id && frame.status === "idle").length;
      const wait = async (before: number): Promise<void> => { await untilCount(idle, before + 1); assert.ok(idle() > before); };
      if (mode === "image") {
        const before = idle();
        result.route = await control.request("probe", { sessionId: id, image: png });
        await wait(before);
        result.sameImage = fixture.provider.requests.some(request => JSON.stringify(request.messages).includes(png));
        assert.equal(result.sameImage, true);
      } else {
        for (const marker of ["alpha", "bravo", "charlie"]) {
          const before = idle();
          // oxlint-disable-next-line no-await-in-loop -- Each seed must be durable before the next.
          await control.request("prompt", { sessionId: id, text: marker + " measured history ".repeat(1600) });
          // oxlint-disable-next-line no-await-in-loop -- Observe that seed's turn boundary.
          await wait(before);
        }
        if (mode === "manual") { result.compact = await control.request("probe", { sessionId: id, commandId }); }
        const events = frames.map(frame => asRecord(frame.event)).filter(event => event?.type === "compaction/start" || event?.type === "compaction/end");
        result.events = events;
        assert.ok(events.some(event => event?.type === "compaction/start"));
        assert.ok(events.some(event => event?.type === "compaction/end" && asRecord(event.data)?.error === undefined));
      }
    });
  }, { models: [{ id: "aimock-model", input: ["text", "image"], contextWindow: 32_768, maxTokens: 2048 }] });
} finally { await writeFile(output, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ mode, version: result.version, passed: true }));
