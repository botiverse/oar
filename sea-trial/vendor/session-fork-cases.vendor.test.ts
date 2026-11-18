import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/index.js";

import { asRecord } from "../../packages/oar/src/shared/json.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import type { AimockEnv } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";
import { codexTurnIds, endedTurns, forkOutputSchema, forkSubjects, historyOf, requestWith, setForkGoalActive, titles, tokenReports } from "./support/session-fork.js";

const backend = process.env.OAR_TEST;
const subject = backend === undefined ? undefined : forkSubjects[backend];

/**
 * SessionOptions.fork edge cases against the real binary with the scripted
 * provider of session-fork.vendor.test.ts: a source still open elsewhere,
 * turns that end on a tool_use (claude names no anchor for them), the copy's
 * name, compaction and goal continuation turns, and codex token totals.
 */
describe.skipIf(subject === undefined)("session fork cases", () => {
  let cwd = "";
  let env: AimockEnv | null = null;
  let reopen: ((extra: Partial<SessionOptions>) => Promise<Session>) | null = null;

  beforeAll(async () => {
    if (subject === undefined) { return; }
    env = await subject.start();
    cwd = await mkdtemp(path.join(tmpdir(), "oar-fork-cases-"));
    const installation = await subject.runtime.installation?.();
    expectAvailable(installation ?? { kind: "missing" }, subject.runtime.id);
    if (installation?.kind !== "available") { return; }
    const claude = subject.runtime.id === "claude";
    const options: SessionOptions = { cwd, env: { ...env.env, ...(claude ? { CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } : {}) } };
    reopen = async (extra) => subject.runtime.session(installation, { ...options, ...extra });
  }, 60_000);

  afterAll(async () => {
    if (cwd !== "") { await removeFixtureDirectory(cwd, "session-fork-cases"); }
    await env?.stop();
  });

  test("a fork of a source still open in another live Session copies its saved turns, and both go on", async () => {
    if (env === null || reopen === null) { return; }
    const source = await reopen({});
    await expect(runTurn(source, "remember FORK-LIVE-APPLE")).resolves.toMatchObject({ kind: "completed" });
    // The source stays open (its process alive) while the fork opens and runs.
    const fork = await reopen({ resume: source.id, fork: {} });
    await expect(runTurn(fork, "which words? FORK-LIVE-Q-FORK")).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(source, "which words? FORK-LIVE-Q-SOURCE")).resolves.toMatchObject({ kind: "completed" });
    await fork.dispose();
    await source.dispose();
    expect(fork.id).not.toBe(source.id);
    const sourceHistory = historyOf(requestWith(env, "FORK-LIVE-Q-SOURCE"));
    expect(JSON.stringify(sourceHistory)).toContain("FORK-LIVE-APPLE");
    expect(JSON.stringify(sourceHistory)).not.toContain("FORK-LIVE-Q-FORK");
    expect(historyOf(requestWith(env, "FORK-LIVE-Q-FORK"))).toEqual(sourceHistory);
  }, 120_000);

  // A fork through a tool_use drops its saved tool_result: such a turn names no anchor.
  test.skipIf(backend !== "claude-aimock")("claude: an outputSchema turn and an error_max_turns turn end on a tool_use and name no anchor; a fork through that tool_use loses its result", async () => {
    if (env === null || reopen === null) { return; }
    const scripted = env;
    /** A fork through the root tool_use calling `tool` (read from the native frame): what its question's request carried. */
    const throughToolUse = async (source: Session, tool: string, question: string, extra: Partial<SessionOptions>): Promise<string> => {
      const frame = source.records().find((record) => record.kind === "frame" && record.body.type === "assistant" && record.agentPath.length === 0
        && JSON.stringify(asRecord(asRecord(record.body.native)?.message)?.content).includes(`"name":"${tool}"`));
      const uuid = frame?.kind === "frame" ? asRecord(frame.body.native)?.uuid : undefined;
      const fork = await reopen?.({ resume: source.id, fork: { through: String(uuid) }, ...extra });
      if (fork === undefined) { throw new Error("no fork"); }
      await runTurn(fork, question);
      await fork.dispose();
      return JSON.stringify(requestWith(scripted, question, "first"));
    };

    const schema = await reopen({ outputSchema: forkOutputSchema });
    await expect(runTurn(schema, "answer FORK-SCHEMA")).resolves.toMatchObject({ kind: "completed", structuredOutput: { answer: 4 } });
    await runTurn(schema, "which words? FORK-SCHEMA-Q-SOURCE");
    await schema.dispose();
    const [answered] = endedTurns(schema.records());
    expect(answered?.outcome?.kind).toBe("completed");
    expect(answered?.forkAnchor).toBeUndefined();
    expect(JSON.stringify(requestWith(scripted, "FORK-SCHEMA-Q-SOURCE", "first"))).toContain("Structured output provided successfully");
    const schemaFork = await throughToolUse(schema, "StructuredOutput", "which words? FORK-SCHEMA-Q-FORK", { outputSchema: forkOutputSchema });
    expect(schemaFork).toContain("Tool result missing due to internal error");
    expect(schemaFork).not.toContain("Structured output provided successfully");

    const loop = await reopen({ launchArgs: ["--max-turns", "1"] });
    await expect(runTurn(loop, "run FORK-LOOP")).resolves.toMatchObject({ kind: "failed", failure: "limit_reached" });
    await runTurn(loop, "which words? FORK-LOOP-Q-SOURCE");
    await loop.dispose();
    const [limited] = endedTurns(loop.records());
    expect(limited?.outcome?.kind).toBe("failed");
    expect(limited?.forkAnchor).toBeUndefined();
    expect(JSON.stringify(requestWith(scripted, "FORK-LOOP-Q-SOURCE", "first"))).toContain("LOOP-DONE");
    const loopFork = await throughToolUse(loop, "Bash", "which words? FORK-LOOP-Q-FORK", { launchArgs: ["--max-turns", "1"] });
    expect(loopFork).toContain("Tool result missing due to internal error");
    expect(loopFork).not.toContain("LOOP-DONE");
  }, 180_000);

  test.skipIf(backend !== "claude-aimock")("claude: name names the copy, and the source keeps its own", async () => {
    if (reopen === null) { return; }
    const source = await reopen({ name: "FORK-NAME-SOURCE" });
    await expect(runTurn(source, "remember FORK-NAME")).resolves.toMatchObject({ kind: "completed" });
    await source.dispose();
    const fork = await reopen({ resume: source.id, fork: {}, name: "FORK-NAME-COPY" });
    await expect(runTurn(fork, "which words? FORK-NAME-Q-FORK")).resolves.toMatchObject({ kind: "completed" });
    await fork.dispose();
    const again = await reopen({ resume: source.id });
    await expect(runTurn(again, "which words? FORK-NAME-Q-SOURCE")).resolves.toMatchObject({ kind: "completed" });
    await again.dispose();
    expect(titles(source.records())).toEqual(["FORK-NAME-SOURCE"]);
    expect(titles(fork.records())).toEqual(["FORK-NAME-COPY"]);
    expect(titles(again.records())).toEqual(["FORK-NAME-SOURCE"]);
  }, 120_000);

  test.skipIf(backend !== "claude-aimock")("claude: in a compacted source, an anchor before the compaction fails the open; one after it forks", async () => {
    if (env === null || reopen === null) { return; }
    const source = await reopen({});
    await expect(runTurn(source, "remember FORK-C-APPLE")).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(source, "remember FORK-C-BANANA")).resolves.toMatchObject({ kind: "completed" });
    await expect(source.compact?.()).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(source, "which words? FORK-C-Q-AFTER")).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(source, "which words? FORK-C-Q-NEXT")).resolves.toMatchObject({ kind: "completed" });
    await source.dispose();
    const anchored = endedTurns(source.records()).flatMap((turn) => turn.forkAnchor === undefined ? [] : [turn.forkAnchor]);
    expect(anchored).toHaveLength(4);
    const [before = "", , after = ""] = anchored;
    await expect(reopen({ resume: source.id, fork: { through: before } })).rejects.toThrow(`No message found with message.uuid of: ${before}`);
    const fork = await reopen({ resume: source.id, fork: { through: after } });
    await expect(runTurn(fork, "which words? FORK-C-Q-FORK")).resolves.toMatchObject({ kind: "completed" });
    await fork.dispose();
    expect(historyOf(requestWith(env, "FORK-C-Q-FORK"))).toEqual(historyOf(requestWith(env, "FORK-C-Q-NEXT")));
  }, 180_000);

  test.skipIf(backend !== "codex-aimock")("codex: a manual compaction turn and a goal continuation turn carry anchors, and a fork through one carries what the source's next prompt carried", async () => {
    if (env === null || reopen === null) { return; }
    const scripted = env;
    const compacted = await reopen({});
    await expect(runTurn(compacted, "remember FORK-CX-APPLE")).resolves.toMatchObject({ kind: "completed" });
    await expect(compacted.compact?.()).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(compacted, "which words? FORK-CX-Q-SOURCE")).resolves.toMatchObject({ kind: "completed" });
    await compacted.dispose();
    const compaction = endedTurns(compacted.records())[1];
    expect(compaction?.forkAnchor).toBe(codexTurnIds(compacted.records(), compacted.id)[1]);
    const compactFork = await reopen({ resume: compacted.id, fork: { through: compaction?.forkAnchor ?? "" } });
    await expect(runTurn(compactFork, "which words? FORK-CX-Q-FORK")).resolves.toMatchObject({ kind: "completed" });
    await compactFork.dispose();
    expect(historyOf(requestWith(scripted, "FORK-CX-Q-FORK"))).toEqual(historyOf(requestWith(scripted, "FORK-CX-Q-SOURCE")));

    const goal = await reopen({ goals: true });
    try {
      await expect(runTurn(goal, "seed FORK-GOAL")).resolves.toMatchObject({ kind: "completed" });
      setForkGoalActive(true);
      expect(await goal.goal?.set({ objective: "Finish the local test on the next automatic continuation", status: "active", tokenBudget: 100_000 })).toMatchObject({ kind: "accepted" });
      await expect.poll(() => endedTurns(goal.records()).length, { timeout: 30_000 }).toBe(3);
    } finally { setForkGoalActive(false); }
    await expect(runTurn(goal, "which words? FORK-GOAL-Q-SOURCE")).resolves.toMatchObject({ kind: "completed" });
    await goal.dispose();
    // Turns 2 and 3 are codex's own continuation turns: one client prompt before them, none in them.
    const continued = endedTurns(goal.records())[2];
    expect(typeof continued?.forkAnchor).toBe("string");
    const goalFork = await reopen({ resume: goal.id, fork: { through: continued?.forkAnchor ?? "" }, goals: true });
    await expect(runTurn(goalFork, "which words? FORK-GOAL-Q-FORK")).resolves.toMatchObject({ kind: "completed" });
    await goalFork.dispose();
    expect(historyOf(requestWith(scripted, "FORK-GOAL-Q-FORK"))).toEqual(historyOf(requestWith(scripted, "FORK-GOAL-Q-SOURCE")));
  }, 180_000);

  test.skipIf(backend !== "codex-aimock")("codex: a fork reports no token totals for its whole Session, while a new thread does", async () => {
    if (reopen === null) { return; }
    const source = await reopen({});
    await expect(runTurn(source, "remember FORK-TOKENS")).resolves.toMatchObject({ kind: "completed" });
    await source.dispose();
    expect(tokenReports(source.records()).tokens).toBeGreaterThan(0);
    const fork = await reopen({ resume: source.id, fork: {} });
    await expect(runTurn(fork, "which words? FORK-TOKENS-1")).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(fork, "which words? FORK-TOKENS-2")).resolves.toMatchObject({ kind: "completed" });
    await fork.dispose();
    expect(tokenReports(fork.records()).usage).toBeGreaterThan(0);
    expect(tokenReports(fork.records()).tokens).toBe(0);
  }, 120_000);
});
