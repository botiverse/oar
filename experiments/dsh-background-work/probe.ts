/* oxlint-disable eslint/no-await-in-loop -- Serial native probes keep each process and gate independent. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { awaitTurnEnd, tasksOf, type RawEvent } from "../../packages/oar/src/index.js";
import { eventsOf, nativeShell, say, untilCount, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { lastInput, toolResults } from "../../sea-trial/vendor/support/dsh-provider.js";

const [output] = process.argv.slice(2);
assert.ok(output !== undefined && output.length > 0, "pass an output directory");
await mkdir(output, { recursive: true });

for (const kind of ["subagent", "shell"] as const) {
  const gate = `release-${kind}`;
  let wakeTool = false;
  await withDshFixture((request) => {
    const input = lastInput(request);
    if (input.includes("BACKGROUND_CHILD")) { return { kind: "hold", text: "child finished" }; }
    if (input.includes("BACKGROUND_ROOT") && toolResults(request) === 0) {
      return kind === "subagent"
        ? { kind: "tool", name: "subagent", arguments: { description: "held child", prompt: "BACKGROUND_CHILD" } }
        : { kind: "tool", name: nativeShell.tool, arguments: { description: "held shell", command: `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf 'SHELL_FINISHED\\n'`, run_in_background: true } };
    }
    if (!input.includes("BACKGROUND_ROOT") && !wakeTool) {
      wakeTool = true;
      return { kind: "tool", name: nativeShell.tool, arguments: nativeShell.where };
    }
    return say(wakeTool ? "wake finished" : "root finished");
  }, async ({ open, provider, aimock, installation }) => {
    assert.ok(installation.via === "executable");
    const session = await open();
    const boundaries: unknown[] = [];
    const select = (records: readonly RawEvent[]): readonly RawEvent[] => records.flatMap(record => record.kind === "frame" && record.sessionId === session.id && (
      record.body.type.startsWith("session/event:job/") || record.body.type === "session/event:turn/start" || record.body.type === "session/event:turn/end"
      || record.body.type.startsWith("subagent/") || (record.body.type === "session/event:user/message" && !record.body.events.some(event => event.kind === "user_message"))
      || record.body.events.some(event => event.kind === "turn_active")) ? [record] : []);
    const subscription = session.rawEvents(record => {
      if (record.kind === "frame" && record.sessionId === session.id && record.body.events.some(event => event.kind === "turn_ended")) {
        boundaries.push({ seq: record.seq, status: session.status().value, tasks: tasksOf(session.records()).value });
      }
    });
    try {
      const started = await session.prompt("BACKGROUND_ROOT", { inputId: "00000000-0000-4000-8000-000000000197" });
      assert.equal(started.kind, "accepted");
      assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "completed" });
      const first = { status: session.status().value, tasks: tasksOf(session.records()).value };
      if (kind === "subagent") { await provider.held(); provider.release(); }
      else { await writeFile(path.join(aimock.cwd, gate), "release"); }
      const ends = (): number => eventsOf(session.records(), session.id).filter(event => event.kind === "turn_ended").length;
      await untilCount(ends, 2);
      assert.equal(ends(), 2);
      assert.equal(wakeTool, true);
      assert.equal(session.status().value.kind, "idle");
      const summary = { kind, version: installation.version, first, final: { status: session.status().value, tasks: tasksOf(session.records()).value }, boundaries, rootEnds: ends(), hostPrompts: session.records().filter(record => record.kind === "request" && record.body.kind === "prompt").length, wakeTool };
      const evidence = { summary, selected: select(session.records()), records: session.records(), requests: provider.requests };
      await writeFile(path.join(output, `${kind}.json`), JSON.stringify(evidence, null, 2));
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      await writeFile(path.join(aimock.cwd, gate), "release");
      subscription();
      await session.dispose();
    }
  });
}
