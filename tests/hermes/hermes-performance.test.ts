import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { RawEvent, Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { hermesAcpProfile } from "../../packages/oar/src/runtimes/hermes/session.js";

/**
 * What a Hermes open actually costs on the wire. The gateway's own session
 * mount is native work OAR cannot remove; everything OAR sends around it is
 * OAR's to keep minimal, and this file pins it: one `initialize`, one session
 * method, and a setter only when the requested value differs from what the
 * gateway reports. Nothing is measured in milliseconds here — the clock belongs
 * to the real-gateway probe (`experiments/hermes-acp/timing.ts`) — so a
 * regression in redundant calls fails deterministically.
 */
const fixture = fileURLToPath(new URL("../fixtures/fake-acp-hermes.mjs", import.meta.url));
const installation = { kind: "available", via: "executable", command: process.execPath } as const;

async function open(options: Partial<SessionOptions> = {}, overrides: Partial<AcpSessionProfile> = {}): Promise<Session> {
  const profile: AcpSessionProfile = { ...hermesAcpProfile, ...overrides, args: [fixture] };
  return acpSession(profile)(installation, { cwd: process.cwd(), ...options });
}

/** The reasoning level one answer reported, if any. */
function effortOf(options: readonly Record<string, unknown>[] | undefined): unknown {
  return options?.find((option) => option.category === "thought_level")?.currentValue;
}

/** The config options one answer carried, read without nesting the two casts. */
function configOptionsOf(frame: RawEvent): readonly Record<string, unknown>[] {
  if (frame.kind !== "frame") { return []; }
  const native = asRecord(frame.body.native);
  return asRecordList(native?.configOptions);
}

/** The native methods this session exchanged, in order, one entry per answer. */
function wire(records: readonly RawEvent[]): string[] {
  return records.flatMap((record) => record.kind === "frame" ? [record.body.type] : []);
}

test("a fresh open costs one initialize and one session/new, with no setter when nothing is requested", async () => {
  const session = await open();
  const methods = wire(session.records());
  assert.deepEqual(methods.slice(0, 2), ["initialize", "session/new"]);
  assert.equal(methods.filter((method) => method === "initialize").length, 1);
  assert.equal(methods.filter((method) => method.startsWith("session/set_config_option")).length, 0);
  await session.dispose();
});

test("a model and effort the gateway already reports are not set again", async () => {
  const session = await open();
  const reportedModel = session.model().value;
  const reportedEffort = session.effort().value;
  await session.dispose();
  // The gateway reports both on session/new; asking for exactly them is a no-op
  // it would otherwise rebuild its whole inventory for.
  const confirming = await open({
    ...(reportedModel === null ? {} : { model: reportedModel }),
    ...(reportedEffort === null ? {} : { effort: reportedEffort }),
  });
  const setters = wire(confirming.records()).filter((method) => method === "session/set_config_option");
  assert.deepEqual(setters, []);
  await confirming.dispose();
});

test("a changed model and effort are each one native setter, the model first", async () => {
  const session = await open({ model: "fixture-model-b", effort: "high" });
  const setterFrames = session.records().filter((record) => record.kind === "frame" && record.body.type === "session/set_config_option");
  const answers = setterFrames.map((frame) => configOptionsOf(frame));
  const methods = wire(session.records());
  assert.equal(answers.length, 2, JSON.stringify(methods));
  // The gateway rebuilds its inventory per setter: the first answer is the
  // model switch (effort still at the gateway's own default), the second the
  // effort. Two writes, never more.
  assert.equal(effortOf(answers[0]), "default");
  assert.equal(effortOf(answers[1]), "high");
  assert.equal(session.effort().value, "high");
  await session.dispose();
});

test("a resume resumes: one initialize, one session/resume, no session/new", async () => {
  const session = await open({ resume: "resume-me" });
  const methods = wire(session.records());
  assert.equal(methods.filter((method) => method === "initialize").length, 1);
  assert.equal(methods.filter((method) => method === "session/new").length, 0);
  assert.equal(methods.filter((method) => method === "session/resume").length, 1);
  await session.dispose();
});

test("no session is closed that this release never advertised closing", async () => {
  // Hermes 0.23.3 advertises fork/list/resume and no close: a `session/close`
  // attempt would be a wasted round-trip and a protocol error.
  const session = await open();
  await session.dispose();
  assert.deepEqual(wire(session.records()).filter((method) => method === "session/close"), []);
});
