import assert from "node:assert/strict";
import { test } from "vitest";
import { ModelConfirmationError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { configureAntigravityModel } from "../../packages/oar/src/runtimes/antigravity/model-selection.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture, describe } from "../fixtures/acp-session-support.js";

async function start(options: Omit<SessionOptions, "cwd">) {
  return acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"], requestTimeoutMs: 2000 })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), ...options });
}

// oxlint-disable-next-line eslint/max-statements -- Verify creation, recorded native values and resume together.
test.each([undefined, "high"])("a legacy composite selector confirms two native settings, explicit effort=%s", async effort => {
  const session = await start({ model: "requested-y-high", ...(effort === undefined ? {} : { effort }) });
  try {
    assert.equal(session.model().value, "requested-y");
    assert.equal(session.effort().value, "high");
    const frames = session.records().map(record => describe(record));
    assert.ok(frames.some(line => line.includes("model:requested-y")), JSON.stringify(frames));
    assert.ok(!JSON.stringify(session.records()).includes("requested-y-high"));
  } finally { await session.dispose(); }
  const resumed = await start({ resume: session.id, model: "requested-y-high" });
  try { assert.equal(resumed.model().value, "requested-y"); assert.equal(resumed.effort().value, "high"); }
  finally { await resumed.dispose(); }
});

test("an exact native selector ending in an effort name is not split", async () => {
  const session = await start({ model: "requested-y-high", effort: "low", env: { FAKE_ACP_AGY_MODEL_MENU: JSON.stringify(["fixture-model-x", "requested-y", "requested-y-high"]) } });
  try { assert.equal(session.model().value, "requested-y-high"); assert.equal(session.effort().value, "low"); }
  finally { await session.dispose(); }
});

test("effort belongs to the selected model, not the initial model", async () => {
  const session = await start({ model: "requested-y-high", env: { FAKE_ACP_AGY_EFFORT_MENUS: JSON.stringify({ "fixture-model-x": ["low"], "requested-y": ["medium", "high"] }) } });
  try { assert.equal(session.model().value, "requested-y"); assert.equal(session.effort().value, "high"); }
  finally { await session.dispose(); }
});

test("conflicting explicit effort is refused", async () => {
  await assert.rejects(start({ model: "requested-y-high", effort: "low" }), error => error instanceof UnsupportedOptionError && error.option === "effort");
});

test.each(["unknown-high", "requested-y-unknown", "requested-y-high-extra"])("unknown selector %s stays a typed model refusal", async model => {
  await assert.rejects(start({ model }), error => error instanceof ModelConfirmationError && error.requested === model && error.catalogSelectorIds?.includes("requested-y") === true);
});

test("a level missing from the target menu is not borrowed from the initial menu", async () => {
  await assert.rejects(start({ model: "requested-y-high", env: { FAKE_ACP_AGY_EFFORT_MENUS: JSON.stringify({ "requested-y": ["low"] }) } }), ModelConfirmationError);
});

test("model notification refusal retains the original composite request and native effort", async () => {
  await assert.rejects(start({ model: "requested-y-high", env: { FAKE_ACP_WRONG_MODEL_UPDATE: "1" } }), error => error instanceof ModelConfirmationError && error.requested === "requested-y-high" && error.reported === "other-model" && error.message.includes("thought_level=medium"));
});

test("effort notification refusal never opens a composite selection", async () => {
  await assert.rejects(start({ model: "requested-y-high", env: { FAKE_ACP_WRONG_EFFORT_UPDATE: "1" } }), /thought_level=high was refused/u);
});

test("ambiguous prefixes do not guess or change native settings", async () => {
  let calls = 0;
  await assert.rejects(configureAntigravityModel({
    options: { cwd: process.cwd(), model: "model-high-extra" },
    response: { configOptions: [{ id: "model", currentValue: "model", options: [{ value: "model" }, { value: "model-high" }] }] },
    setModel: async () => { calls++; return {}; }, setEffort: async () => { calls++; return {}; },
  }), ModelConfirmationError);
  assert.equal(calls, 0);
});

test("a matching effort response cannot hide a model change", async () => {
  await assert.rejects(configureAntigravityModel({
    options: { cwd: process.cwd(), model: "model-high" },
    response: { configOptions: [{ id: "model", currentValue: "model", options: [{ value: "model" }] }] },
    setModel: async () => ({ configOptions: [{ id: "model", currentValue: "model" }, { category: "thought_level", options: [{ value: "high" }] }] }),
    setEffort: async () => ({ configOptions: [{ id: "model", currentValue: "other" }, { category: "thought_level", currentValue: "high" }] }),
  }), ModelConfirmationError);
});
