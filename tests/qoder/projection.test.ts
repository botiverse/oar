import assert from "node:assert/strict";
import { expect, test } from "vitest";
import quota from "../fixtures/qoder-quota.json" with { type: "json" };
import turns from "../fixtures/qoder-native-turns.json" with { type: "json" };
import cancelled from "../fixtures/qoder-cancelled-input.json" with { type: "json" };
import { foldStreamJsonStdout } from "../../packages/oar/src/shared/stream-json/projection.js";
import { streamJsonPrompted } from "../../packages/oar/src/shared/stream-json/input-lifecycle.js";
import { initialQoderProjection, qoderProjectionProfile } from "../../packages/oar/src/runtimes/qoder/projection.js";

test("Qoder's startup init does not invent an active turn", () => {
  const [init] = turns; assert.ok(init);
  const next = foldStreamJsonStdout(qoderProjectionProfile, initialQoderProjection(), init);
  expect(next.state.turnActive).toBe(false);
  expect(next.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).some((event) => event.kind === "turn_active")).toBe(false);
});

test("only an unowned root init after startup adopts a Qoder turn", () => {
  let state = initialQoderProjection();
  const fold = (native: Record<string, unknown>) => {
    const result = foldStreamJsonStdout(qoderProjectionProfile, state, native);
    ({ state } = result);
    return result.commands.flatMap(c => c.kind === "frame" ? c.body.events.filter(e => e.kind === "turn_active") : []);
  };
  const init = { type: "system", subtype: "init" };
  expect([{ ...init, parent_tool_use_id: "child" }, init].flatMap(frame => fold(frame))).toEqual([]);
  state = streamJsonPrompted(state, "host");
  const command = { type: "command_lifecycle", command_uuid: "host" };
  expect([{ ...command, state: "queued" }, init, { ...command, state: "started" }].map(frame => fold(frame)))
    .toEqual([[], [], [{ kind: "turn_active", inputId: "host" }]]);
  expect([{ type: "result", subtype: "success" }, { ...init, parent_tool_use_id: "child" }, init, init].map(frame => fold(frame)))
    .toEqual([[], [], [{ kind: "turn_active" }], []]);
});

test("an overlapping notification result never inherits the pending host input ID", () => {
  const init = { type: "system", subtype: "init" };
  const result = { type: "result", subtype: "success" };
  const command = { type: "command_lifecycle", command_uuid: "host" };
  const startup = foldStreamJsonStdout(qoderProjectionProfile, initialQoderProjection(), init);
  let state = streamJsonPrompted(startup.state, "host");
  // Notification init wins the race after the write. Qoder subsequently
  // acknowledges the host command as queued, then starts it after this result.
  const records = [init, { ...command, state: "queued" }, result, init,
    { ...command, state: "started" }, { ...result, user_message_uuid: "host" }].map(frame => {
    const folded = foldStreamJsonStdout(qoderProjectionProfile, state, frame);
    ({ state } = folded);
    return folded.commands.flatMap(entry => entry.kind === "frame" ? entry.body.events : []);
  });
  expect(records).toEqual([[], [{ kind: "input_queued", inputId: "host" }],
    [{ kind: "turn_ended", outcome: { kind: "completed" } }], [],
    [{ kind: "turn_active", inputId: "host" }], [{ kind: "turn_ended", inputId: "host", outcome: { kind: "completed" } }]]);
});

test("native cancellation before start drops only that input without inventing a turn end", () => {
  const [queued, dropped] = cancelled; assert.ok(queued && dropped);
  const prompted = streamJsonPrompted(initialQoderProjection(), queued.command_uuid);
  const pending = foldStreamJsonStdout(qoderProjectionProfile, prompted, queued);
  const next = foldStreamJsonStdout(qoderProjectionProfile, pending.state, dropped);
  expect(next.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []))
    .toEqual([{ kind: "input_dropped", inputId: queued.command_uuid, reason: "turn_interrupted" }]);
  expect(next.state.turnActive).toBe(false);
  expect(next.state.unstartedInputs.size).toBe(0);
});

test("native credit exhaustion remains billing failure with its exact reason and zero wire usage", () => {
  expect(quota).toHaveLength(2);
  for (const frame of quota) {
    const next = foldStreamJsonStdout(qoderProjectionProfile, initialQoderProjection(false), frame);
    const record = next.commands.find((command) => command.kind === "frame");
    expect(record?.body.native).toBe(frame);
    expect(record?.body.events).toEqual([{ kind: "turn_ended", outcome: { kind: "failed", failure: "billing", reason: frame.errors.join("\n") } }]);
    expect(frame.usage.input_tokens).toBe(0);
    expect(frame.usage.output_tokens).toBe(0);
  }
});

// One native transcript exercises lifecycle, usage and content together.
// oxlint-disable-next-line max-statements
test("native exposed query totals accumulate once across two turns", () => {
  let state = initialQoderProjection();
  const texts: string[] = [];
  for (const frame of turns) {
    const next = foldStreamJsonStdout(qoderProjectionProfile, state, frame); ({ state } = next);
    texts.push(...next.commands.flatMap((command) => command.kind === "frame"
      ? command.body.events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []) : []));
  }
  expect(state.usage).toEqual({ input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });
  expect(texts.join("")).toBe("OTTER_1OTTER_2");
});

test("Qoder's repeated compacting status emits one start and the status clear emits no end", () => {
  let state = initialQoderProjection();
  const events = ["compacting", "compacting", null].map(status => {
    const next = foldStreamJsonStdout(qoderProjectionProfile, state, { type: "system", subtype: "status", status });
    ({ state } = next);
    return next.commands.flatMap(command => command.kind === "frame" ? command.body.events : []);
  });
  expect(events).toEqual([[{ kind: "compaction_started" }], [], []]);
});
