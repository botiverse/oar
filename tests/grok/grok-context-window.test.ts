/*
 * Grok reports a context *count* in every prompt answer (`_meta.totalTokens`)
 * and a per-model context *window* only in its model table
 * (`session/new`'s `models.availableModels[]._meta.totalContextTokens`; the
 * same table `_x.ai/models/list` returns, docs/runtimes/grok.md). OAR fills the
 * missing half from that table for the model the runtime last reported, and
 * reports no window at all for a model whose row it never read — so a window
 * can never outlive the evidence for it.
 */
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/index.js";
import { grokContextUsage,grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { createAcpModelContextWindow } from "../../packages/oar/src/shared/acp/model.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { fixture, profile } from "../fixtures/acp-session-support.js";

const installation = { kind: "available", via: "executable", command: process.execPath } as const;

async function startGrok(windows: Readonly<Record<string, number>>, model?: string): Promise<Session> {
  return acpSession({ ...grokAcpProfile, ...profile(), args: [fixture, "grok-usage"] })(installation, {
    cwd: process.cwd(),
    env: { FAKE_ACP_MODEL_WINDOWS: JSON.stringify(windows) },
    ...(model === undefined ? {} : { model }),
  });
}

test("the open answer's model table supplies the window its prompt answer omits", async () => {
  const session = await startGrok({ "fixture-model-x": 500_000 });
  try {
    const turn = await promptAndWait(session, "grok-usage");
    expect(turn.kind).toBe("ended");
    const usage = session.contextUsage().value;
    // The count rides the answer; the window is the opened model's advertised row.
    expect(usage).toMatchObject({ contextWindow: 500_000 });
    expect(usage?.tokens).toBeGreaterThan(0);
    expect(usage?.percent).toBe(Math.round(((usage?.tokens ?? 0) / 500_000) * 100));
  } finally {
    await session.dispose();
  }
});

test("a model with no advertised row reports the count and no window", async () => {
  const session = await startGrok({ "requested-y": 500_000 });
  try {
    await promptAndWait(session, "grok-usage");
    expect(session.contextUsage().value).toMatchObject({ contextWindow: null, percent: null });
  } finally {
    await session.dispose();
  }
});

test("a model switch out of the advertised table drops the window instead of keeping a stale one", async () => {
  const session = await startGrok({ "fixture-model-x": 500_000 }, "switch-to-z");
  try {
    // The fixture answers `session/set_model` by pushing the model it really runs.
    expect(session.model().value).toBe("fixture-model-z");
    await promptAndWait(session, "grok-usage");
    expect(session.contextUsage().value).toMatchObject({ contextWindow: null, percent: null });
  } finally {
    await session.dispose();
  }
});

test("the advertised-window fold keeps a table it read and never invents a row", () => {
  const windows = createAcpModelContextWindow();
  windows.observe({ models: { currentModelId: "a", availableModels: [{ modelId: "a", _meta: { totalContextTokens: 200_000 } }, { modelId: "b" }] } });
  expect(windows.window()).toBe(200_000);
  // A frame that carries no table keeps the last one; a model row it never read has no window.
  windows.observe({ _meta: { model: "b" } });
  expect(windows.window()).toBeNull();
  windows.observe({ _meta: { model: "a" } });
  expect(windows.window()).toBe(200_000);
  // A model report before any table claims nothing at all.
  const empty = createAcpModelContextWindow();
  empty.observe({ _meta: { model: "a" } });
  expect(empty.window()).toBeNull();
});

test("a window the answer itself carries wins over the table", () => {
  expect(grokContextUsage({ _meta: { totalTokens: 1000, contextWindow: 32_000 } }, 500_000)).toEqual({ tokens: 1000, contextWindow: 32_000, percent: 3 });
  expect(grokContextUsage({ _meta: { totalTokens: 1000 } }, 500_000)).toEqual({ tokens: 1000, contextWindow: 500_000, percent: 0 });
  expect(grokContextUsage({ _meta: { totalTokens: 1000 } }, null)).toEqual({ tokens: 1000, contextWindow: null, percent: null });
});

/** The model name one session's own `config_option_update` carries. */
function modelReportedBy(sessionId: string, currentValue: string): Parameters<ReturnType<typeof createAcpRecorder>["update"]>[0] {
  return { sessionId, update: { sessionUpdate: "config_option_update", configOptions: [{ type: "select", id: "model", name: "Model", category: "model", currentValue, options: [] }] } };
}

test("a child session's own model report never blanks the root's window", () => {
  const kernel = createSessionKernel("root");
  const recorder = createAcpRecorder(createUsageUpdateGate());
  recorder.bind(kernel);
  recorder.step("session/new", { models: { currentModelId: "a", availableModels: [{ modelId: "a", _meta: { totalContextTokens: 200_000 } }] } });
  expect(recorder.modelContextWindow()).toBe(200_000);
  // The child's frame names its own session, so it speaks for the child only.
  recorder.update(modelReportedBy("child", "b"));
  expect(recorder.modelContextWindow()).toBe(200_000);
  // The root's own report still moves it, and an unread row reports none.
  recorder.update(modelReportedBy("root", "b"));
  expect(recorder.modelContextWindow()).toBeNull();
});
