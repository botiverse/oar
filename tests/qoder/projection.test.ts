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
