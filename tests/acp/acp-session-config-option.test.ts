/* oxlint-disable eslint/max-statements -- Each scenario keeps one ordered control exchange together. */
import { expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { describe, fixture, start } from "../fixtures/acp-session-support.js";

test("an ACP session sets a config option through a recorded control and folds its reported value", async () => {
  const session = await start();
  try {
    expect(typeof session.setConfigOption).toBe("function");
    const result = await session.setConfigOption?.("fixture_effort", "high");
    expect(result).toMatchObject({ kind: "accepted" });
    expect(result?.request.body).toMatchObject({ kind: "set_config_option", configId: "fixture_effort", value: "high" });
    expect(result?.response.body).toMatchObject({ kind: "accepted" });
    expect(session.effort().value).toBe("high");
    const answer = session.records().find(record => record.kind === "frame" && record.body.responseTo === result?.request.id);
    expect(answer).toMatchObject({ body: { type: "session/set_config_option" } });
    if (answer === undefined) { throw new Error("missing config answer frame"); }
    expect(describe(answer)).toBe("event session/set_config_option → model:fixture-model-x, effort:high");
  } finally {
    await session.dispose();
  }
});

test("a runtime refusal answers the config control rejected and keeps the native error correlated", async () => {
  const session = await start();
  try {
    const result = await session.setConfigOption?.("missing_option", "high");
    expect(result).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    const answer = session.records().find(record => record.kind === "frame" && record.body.responseTo === result?.request.id);
    expect(answer).toMatchObject({ body: { type: "session/set_config_option/error" } });
  } finally {
    await session.dispose();
  }
});

test("ACP does not hold a config option change for the active turn", async () => {
  const session = await start();
  try {
    const first = await session.prompt("hold");
    expect(first.response.body.kind).toBe("accepted");
    const changed = await session.setConfigOption?.("fixture_effort", "high");
    expect(changed).toMatchObject({ kind: "accepted" });
    expect(session.effort().value).toBe("high");
    const aborted = await session.abort();
    expect(aborted.response.body.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, first.request.seq)).toMatchObject({ kind: "aborted" });
  } finally {
    await session.dispose();
  }
});

test("a profile that confirms config updates accepts a live change on the positive notification", async () => {
  const session = await acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd() },
  );
  try {
    const result = await session.setConfigOption?.("thought_level", "high");
    expect(result).toMatchObject({ kind: "accepted" });
    expect(session.effort().value).toBe("high");
    const answer = session.records().find(record => record.kind === "frame" && record.body.responseTo === result?.request.id);
    expect(answer).toMatchObject({ body: { type: "session/set_config_option" } });
  } finally {
    await session.dispose();
  }
});
