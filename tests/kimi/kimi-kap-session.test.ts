import { afterEach, expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { ModelConfirmationError } from "../../packages/oar/src/contracts/model-confirmation-error.js";
import { ResumeCwdError } from "../../packages/oar/src/contracts/resume-cwd-error.js";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import { SessionNotFoundError } from "../../packages/oar/src/contracts/session-not-found-error.js";
import { SessionUnavailableError } from "../../packages/oar/src/contracts/session-unavailable-error.js";
import type { Event, RawEvent, Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { createKapTestFixture, finishAndDispose, randomUUID, waitTurnStarted, waitUntil, type KapTestFixture } from "../fixtures/kimi-kap-support.js";

const cleanups: (() => void)[] = [];

function useFixture(): KapTestFixture {
  const fx = createKapTestFixture();
  cleanups.push(() => { fx.cleanup(); });
  return fx;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

async function assertFallbackAcp(fx: KapTestFixture, version: string, scenario: string): Promise<void> {
  const session = await fx.open(version, {
    env: { FAKE_KIMI_SCENARIO: scenario, FAKE_KIMI_LOG: fx.logFile },
  });
  expect(session.id).toBe("acp-fallback-session-1");
  expect(session.capabilities.attribution).toBe("opaque");
  await session.dispose();
}

async function releaseAndFinish(session: Session, pendingTurn: Promise<unknown>, label: string): Promise<void> {
  await session.steer?.("release");
  await pendingTurn;
  await finishAndDispose(session, label);
}

test("falls back to ACP on 2.7.2, 2.7.2-botiverse.0, missing /meta capability, and unknown --json flag", async () => {
  const fx = useFixture();
  await assertFallbackAcp(fx, "2.7.2", "normal");
  await assertFallbackAcp(fx, "2.7.2-botiverse.0", "normal");
  await assertFallbackAcp(fx, "2.7.2-botiverse.1", "missing_cap");
  await assertFallbackAcp(fx, "2.7.2-botiverse.1", "unknown_json_flag");
});

test("rejects missing auth without leaking bearer token and surfaces model/effort rejections on open", async () => {
  const fx = useFixture();
  const authEnv = { FAKE_KIMI_SCENARIO: "auth_missing", FAKE_KIMI_TOKEN: "tok-auth-secret" };
  await expect(fx.open("2.7.2-botiverse.1", { env: authEnv })).rejects.toThrow(RuntimeFailureError);
  const leaked = await fx.open("2.7.2-botiverse.1", { env: authEnv }).catch(String);
  expect(leaked).not.toContain("tok-auth-secret");

  await expect(fx.open("2.7.2-botiverse.1", { model: "expected-model", env: { FAKE_KIMI_SCENARIO: "wrong_model" } })).rejects.toThrow(ModelConfirmationError);
  await expect(fx.open("2.7.2-botiverse.1", { effort: "high", env: { FAKE_KIMI_SCENARIO: "wrong_effort" } })).rejects.toThrow(UnsupportedOptionError);
});

test("rejects reserved or duplicate mcpServers names before spawning KAP", async () => {
  const fx = useFixture();
  await expect(fx.open("2.7.2-botiverse.1", {
    mcpServers: [{ name: "__proto__", type: "http", url: "http://127.0.0.1:9999/mcp" }],
  })).rejects.toThrow(UnsupportedOptionError);
  await expect(fx.open("2.7.2-botiverse.1", {
    mcpServers: [
      { name: "dup", command: "echo" },
      { name: "dup", type: "http", url: "http://127.0.0.1:9999/mcp" },
    ],
  })).rejects.toThrow(/twice/iu);
});

test("enforces resume pre-checks for missing, archived, in_use, and mismatched cwd sessions", async () => {
  const fx = useFixture();
  await expect(fx.open("2.7.2-botiverse.1", { resume: "s-1", env: { FAKE_KIMI_SCENARIO: "resume_not_found" } })).rejects.toThrow(SessionNotFoundError);
  await expect(fx.open("2.7.2-botiverse.1", { resume: "s-1", env: { FAKE_KIMI_SCENARIO: "resume_archived" } })).rejects.toThrow(SessionUnavailableError);
  await expect(fx.open("2.7.2-botiverse.1", { resume: "s-1", env: { FAKE_KIMI_SCENARIO: "resume_in_use" } })).rejects.toThrow(SessionUnavailableError);
  await expect(fx.open("2.7.2-botiverse.1", { resume: "s-1", env: { FAKE_KIMI_SCENARIO: "resume_other_cwd" } })).rejects.toThrow(ResumeCwdError);
});

test("forwards mcpServers and appendSystemPrompt on :resume and filters buffered historical turns", async () => {
  const fx = useFixture();
  const opts: Partial<SessionOptions> = {
    resume: "s-resumed",
    appendSystemPrompt: "custom instructions",
    mcpServers: [{ name: "local-http", type: "http", url: "http://127.0.0.1:9999/mcp" }],
    env: { FAKE_KIMI_SCENARIO: "resume_history", FAKE_KIMI_LOG: fx.logFile },
  };
  const session = await fx.open("2.7.2-botiverse.1", opts);
  await session.prompt("hello after cold resume");
  await finishAndDispose(session, "post-resume prompt");
  const resumeCall = fx.readLog().find((entry) => entry.url === "/api/v1/sessions/s-resumed:resume");
  expect(resumeCall?.body).toMatchObject({ append_system_prompt: "custom instructions", mcp_servers: { "local-http": { transport: "http", url: "http://127.0.0.1:9999/mcp" } } });
  expect(JSON.stringify(session.records())).not.toContain("\"kind\":\"text_delta\",\"text\":\"historical-text\"");
});

test("handles WS-before-HTTP race, busy rejection, and mid-turn steer", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { model: "default-model", env: { FAKE_KIMI_LOG: fx.logFile } });
  const pRace = session.prompt("HOLD_FOR_CONTROLS RACE_WS_FIRST");
  await waitTurnStarted(session, "WS-before-HTTP turn.started");
  const busy = await session.prompt("busy");
  const steered = await session.steer?.("steer-msg");
  expect(busy.response.body).toMatchObject({ kind: "rejected", code: "busy" });
  expect(steered?.response.body.kind).toBe("accepted");
  await pRace;
  await finishAndDispose(session, "steered turn");
});

test("supports queue and withdraw lifecycle", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { model: "default-model", env: { FAKE_KIMI_LOG: fx.logFile } });
  const inputId = randomUUID();
  const activeTurn = session.prompt("HOLD_FOR_CONTROLS");
  await waitTurnStarted(session, "held turn for withdraw");
  const queued = await session.queue("withdrawn", { inputId });
  const w1 = await session.withdraw?.(inputId);
  const w2 = await session.withdraw?.(inputId);
  expect([queued.response.body, w1?.response.body, w2?.response.body]).toEqual([
    expect.objectContaining({ kind: "accepted", queued: "adapter" }),
    { kind: "accepted" },
    expect.objectContaining({ kind: "rejected", code: "not_queued" }),
  ]);
  await releaseAndFinish(session, activeTurn, "withdraw release");
});

test("drains queued input after active turn ends", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { model: "default-model", env: { FAKE_KIMI_LOG: fx.logFile } });
  const events: Event[] = [];
  session.events((ev) => { events.push(ev); });
  const activeTurn = session.prompt("HOLD_FOR_CONTROLS");
  await waitTurnStarted(session, "held turn for queue");
  const kept = await session.queue("QUEUED_KEPT", { inputId: randomUUID() });
  expect(kept.response.body).toMatchObject({ kind: "accepted", queued: "adapter" });
  await releaseAndFinish(session, activeTurn, "drained queue turn");
  expect(events.some((e) => e.kind === "text_delta" && e.text.includes("reply:QUEUED_KEPT"))).toBe(true);
});

test("supports image prompt and manual compact", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { model: "default-model", additionalDirectories: [fx.extraDir], env: { FAKE_KIMI_LOG: fx.logFile } });
  const imgRes = await session.prompt("", { images: [{ path: fx.imagePath }] });
  expect(imgRes.response.body.kind).toBe("accepted");
  await waitUntil(() => session.status().value.kind === "idle", "Timed out waiting for image turn");
  const compacted = await session.compact?.();
  expect(compacted?.kind).toBe("completed");
  await session.dispose();
});

test("supports stopTask over WS and rejects idle steer", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  const stopped = await session.stopTask?.("task-99");
  const idleSteer = await session.steer?.("idle");
  expect(stopped?.response.body).toMatchObject({ kind: "accepted", native: { data: { stopped: "task-99" } } });
  expect(idleSteer?.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  await session.dispose();
});

test("redacts bearer token from raw events and closes WS before shutdown without deleting workspace on normal dispose", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { model: "default-model", additionalDirectories: [fx.extraDir], env: { FAKE_KIMI_LOG: fx.logFile, FAKE_KIMI_TOKEN: "bearer-redact-check" } });
  const raw: RawEvent[] = [];
  session.rawEvents((rec) => { raw.push(rec); });
  await session.prompt("hello");
  await finishAndDispose(session, "hello turn");
  expect(JSON.stringify(raw)).not.toContain("bearer-redact-check");
  const log = fx.readLog();
  expect(log.find((e) => "shutdownWsOpen" in e)?.shutdownWsOpen).toBe(false);
  expect(log.some((e) => e.method === "DELETE" && typeof e.url === "string" && e.url.startsWith("/api/v1/workspaces/"))).toBe(false);
});

test("records and auto-answers interactions", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  const intRes = await session.prompt("INTERACT");
  expect(intRes.response.body.kind).toBe("accepted");
  await waitUntil(() => session.records().some((r) => r.kind === "response" && r.body.kind === "answered"), "Timed out waiting for interaction");
  await finishAndDispose(session, "interaction turn");
  expect(session.records().find((r) => r.kind === "request" && r.direction === "toApp")?.body).toMatchObject({ kind: "native", type: "interaction/approval" });
});

test("rejects idle abort and cancels active turn on abort", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  const idleAbort = await session.abort();
  expect(idleAbort.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  await session.prompt("HOLD_FOR_CONTROLS", { inputId: randomUUID() });
  const activeAbort = await session.abort();
  expect(activeAbort.response.body.kind).toBe("accepted");
  await finishAndDispose(session, "abort turn");
});
