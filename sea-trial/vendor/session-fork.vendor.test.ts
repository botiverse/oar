import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { awaitTurnEnd, claudeRuntime, codexRuntime, type RawEvent, type Runtime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";

import { viewOf, type ViewTurn } from "../../packages/oar/src/observe/session-view.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { startClaudeAimock, startCodexAimock, type AimockEnv, type LLMock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";

const backend = process.env.OAR_TEST;
/** The repository's stdio echo MCP server, so a fork carries a `config.mcp_servers` override. */
const ECHO = { name: "echo", command: process.execPath, args: [path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "echo-mcp-server.mjs")] };
/**
 * "noted" to everything, except a 400 for a prompt naming FORK-FAIL (a failed
 * turn) and a long shell command for one naming FORK-TOOL (a turn to abort).
 */
function fixtures(claude: boolean): (mock: LLMock) => void {
  return (mock) => {
    mock.onMessage(/FORK-FAIL/u, { status: 400, error: { type: "invalid_request_error", ...(claude ? {} : { code: "invalid_request" }), message: "fork-fail" } });
    mock.on({ userMessage: /FORK-TOOL/u, hasToolResult: false }, { toolCalls: [{ id: "call-wait", name: claude ? "Bash" : "exec_command", arguments: JSON.stringify(claude ? { command: "for i in $(seq 60); do sleep 1; done" } : { cmd: "for i in $(seq 60); do sleep 1; done" }) }] });
    mock.onMessage(/[\s\S]*/u, { content: "noted" });
  };
}
const subjects: Readonly<Record<string, { readonly runtime: Runtime; readonly start: () => Promise<AimockEnv> }>> = {
  "claude-aimock": { runtime: claudeRuntime, start: async () => startClaudeAimock(fixtures(true)) },
  "codex-aimock": { runtime: codexRuntime, start: async () => startCodexAimock(fixtures(false)) },
};
const subject = backend === undefined ? undefined : subjects[backend];

interface Turn { readonly role: string; readonly text: string }

/** The provider request that carried `marker` last (or first): the one the turn prompted with it sent. */
function requestWith(env: AimockEnv, marker: string, which: "first" | "last" = "last"): unknown {
  const requests = env.mock.getRequests();
  const carries = (request: unknown): boolean => JSON.stringify(request).includes(marker);
  const found = which === "last" ? requests.findLast((request) => carries(request)) : requests.find((request) => carries(request));
  if (found === undefined) { throw new Error(`no provider request carried ${marker}`); }
  return found;
}

function textOf(content: unknown): string {
  if (typeof content === "string") { return content; }
  return Array.isArray(content) ? content.map((part) => { const text = asRecord(part)?.text; return typeof text === "string" ? text : ""; }).join("") : "";
}

/**
 * The conversation a provider request carried before its final user message
 * (the prompt that sent it): every user and assistant message, in order, as
 * the runtime replayed it. System prompts are left out.
 */
function historyOf(request: unknown): Turn[] {
  const body = asRecord(asRecord(request)?.body);
  const messages: unknown[] = Array.isArray(body?.messages) ? body.messages : [];
  const turns = messages.map((message) => asRecord(message)).flatMap((message) => message?.role === "user" || message?.role === "assistant" ? [{ role: message.role, text: textOf(message.content) }] : []);
  const last = turns.findLastIndex((turn) => turn.role === "user");
  return turns.slice(0, last);
}

/** The root turns' fork anchors, in order, from the session view of its records. */
function anchors(records: readonly RawEvent[]): (string | undefined)[] {
  return endedTurns(records).map((turn) => turn.forkAnchor);
}

function endedTurns(records: readonly RawEvent[]): ViewTurn[] {
  return viewOf(records).messages.filter((message): message is ViewTurn => message.kind === "turn" && message.outcome !== undefined);
}

/** The distinct model and effort reports the runtime made. */
function settings(records: readonly RawEvent[]): string[] {
  return [...new Set(records.flatMap((record) => record.kind === "frame" ? record.body.events.flatMap((event) => {
    if (event.kind === "model") { return [`model ${event.model}`]; }
    return event.kind === "effort" ? [`effort ${event.effort}`] : [];
  }) : []))];
}

/** Prompt a turn that starts a long shell command, abort it once the command runs, and wait for the turn's end. */
async function abortedTurn(session: Session): Promise<void> {
  const { request } = await session.prompt("run FORK-TOOL");
  await expect.poll(() => session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started")), { timeout: 30_000 }).toBe(true);
  await session.abort();
  await expect(awaitTurnEnd(session, request.seq)).resolves.toMatchObject({ kind: "aborted" });
}

/** The ids the runtime itself reported for the session in its frames: claude `system/init` `session_id`; codex the `thread/fork` reply's and the `thread/started` notification's thread id. */
function reportedIds(records: readonly RawEvent[]): string[] {
  return records.flatMap((record) => {
    const native = record.kind === "frame" ? asRecord(record.body.native) : null;
    if (record.kind !== "frame" || native === null) { return []; }
    if (record.body.type === "system/init" && typeof native.session_id === "string") { return [native.session_id]; }
    const thread = asRecord(native.thread)?.id;
    return (record.body.type === "thread/fork" || record.body.type === "thread/started") && typeof thread === "string" ? [thread] : [];
  });
}

/** The native transcript holding session `id` (claude `<id>.jsonl`, codex `rollout-…-<id>.jsonl`) under `root`. */
async function transcript(root: string, id: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const file = entries.find((entry) => entry.isFile() && entry.name.endsWith(`${id}.jsonl`));
  if (file === undefined) { throw new Error(`no native transcript for ${id} under ${root}`); }
  return readFile(path.join(file.parentPath, file.name), "utf8");
}

interface Opened { readonly id: string; readonly records: readonly RawEvent[]; readonly request: unknown }

/**
 * SessionOptions.fork against the real binary with a scripted provider. A
 * source runs "remember FORK-APPLE" and "remember FORK-BANANA"; then three
 * forks each ask one question: through the first turn's anchor, through the
 * last turn's, and of the whole session; finally the source itself is
 * resumed and asked. What the provider receives for each question is that
 * session's history as the runtime replays it.
 */
describe.skipIf(subject === undefined)("session fork", () => {
  const run = { cwd: "", nativeRoot: "", sourceId: "", firstAnchor: "", lastAnchor: "", before: "", after: "" };
  const opened: Record<string, Opened> = {};
  let env: AimockEnv | null = null;
  let sourceBananaRequest: unknown = null;
  let reopen: ((extra: Partial<SessionOptions>) => Promise<Session>) | null = null;

  beforeAll(async () => {
    if (subject === undefined) { return; }
    env = await subject.start();
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-fork-"));
    run.cwd = cwd;
    const installation = await subject.runtime.installation?.();
    expectAvailable(installation ?? { kind: "missing" }, subject.runtime.id);
    if (installation?.kind !== "available") { return; }
    // claude keeps transcripts under CLAUDE_CONFIG_DIR; codex its rollouts under the fixture's CODEX_HOME.
    const claude = subject.runtime.id === "claude";
    run.nativeRoot = claude ? cwd : String(env.env?.CODEX_HOME);
    const options: SessionOptions = { cwd, env: { ...env.env, ...(claude ? { CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null } : {}) } };
    const scripted = env;
    reopen = async (extra) => subject.runtime.session(installation, { ...options, ...extra });
    const ask = async (name: string, extra: Partial<SessionOptions>, question: string): Promise<void> => {
      const session = await subject.runtime.session(installation, { ...options, ...extra });
      await expect(runTurn(session, question)).resolves.toMatchObject({ kind: "completed" });
      await session.dispose();
      opened[name] = { id: session.id, records: session.records(), request: requestWith(scripted, question) };
    };

    const source = await subject.runtime.session(installation, options);
    await expect(runTurn(source, "remember FORK-APPLE")).resolves.toMatchObject({ kind: "completed" });
    await expect(runTurn(source, "remember FORK-BANANA")).resolves.toMatchObject({ kind: "completed" });
    await source.dispose();
    sourceBananaRequest = requestWith(env, "FORK-BANANA");
    run.sourceId = source.id;
    const [firstAnchor = "", lastAnchor = ""] = anchors(source.records());
    run.firstAnchor = firstAnchor;
    run.lastAnchor = lastAnchor;
    run.before = await transcript(run.nativeRoot, source.id);

    await ask("first", { resume: run.sourceId, fork: { through: run.firstAnchor } }, "which words? FORK-Q-FIRST");
    await ask("last", { resume: run.sourceId, fork: { through: run.lastAnchor } }, "which words? FORK-Q-LAST");
    await ask("whole", { resume: run.sourceId, fork: {} }, "which words? FORK-Q-WHOLE");
    run.after = await transcript(run.nativeRoot, run.sourceId);
    await ask("source", { resume: run.sourceId }, "which words? FORK-Q-SOURCE");
  }, 300_000);

  afterAll(async () => {
    if (run.cwd !== "") { await removeFixtureDirectory(run.cwd, "session-fork"); }
    await env?.stop();
  });

  test("check 1: each fork runs under a new id that the runtime itself reports", () => {
    const forks = [opened.first, opened.last, opened.whole];
    const ids = forks.map((fork) => fork?.id);
    expect(new Set([run.sourceId, ...ids]).size).toBe(4);
    for (const fork of forks) {
      // claude: system/init of the fork's turn (its open already required get_status to say the same);
      // codex: the thread/fork reply and the thread/started notification.
      const reported = reportedIds(fork?.records ?? []);
      expect(reported.length).toBeGreaterThan(0);
      expect(new Set(reported)).toEqual(new Set([fork?.id]));
    }
    expect(reportedIds(opened.source?.records ?? []).every((id) => id === run.sourceId)).toBe(true);
  });

  test("check 2: the source is unchanged: its native transcript is byte-identical after three forks, and it resumes with its own two turns only", async () => {
    expect(run.after).toBe(run.before);
    expect(opened.source?.id).toBe(run.sourceId);
    const history = historyOf(opened.source?.request);
    expect(history.filter((turn) => turn.role === "user").map((turn) => turn.text).join("\n")).toMatch(/FORK-APPLE[\s\S]*FORK-BANANA/u);
    expect(JSON.stringify(history)).not.toMatch(/FORK-Q-(?:FIRST|LAST|WHOLE)/u);
    // The forks are files of their own.
    for (const name of ["first", "last", "whole"]) {
      // oxlint-disable-next-line no-await-in-loop -- one transcript at a time keeps the failure attributable.
      expect(await transcript(run.nativeRoot, opened[name]?.id ?? "")).not.toBe(run.before);
    }
  });

  test("check 3: a fork through the first turn holds exactly the history up to that turn's end", () => {
    const history = historyOf(opened.first?.request);
    // The source's second prompt carried exactly turn 1 as its history.
    expect(history).toEqual(historyOf(sourceBananaRequest));
    expect(history.some((turn) => turn.text.includes("FORK-APPLE"))).toBe(true);
    expect(history.filter((turn) => turn.role === "assistant").map((turn) => turn.text)).toEqual(["noted"]);
    expect(history.at(-1)?.role).toBe("assistant");
    expect(JSON.stringify(history)).not.toContain("FORK-BANANA");
  });

  test("check 4: a fork through the last turn holds the same history as a fork of the whole session, and as the source", () => {
    const last = historyOf(opened.last?.request);
    expect(last).toEqual(historyOf(opened.whole?.request));
    expect(last).toEqual(historyOf(opened.source?.request));
    expect(JSON.stringify(last)).toMatch(/FORK-APPLE[\s\S]*FORK-BANANA/u);
    expect(last.filter((turn) => turn.role === "assistant")).toHaveLength(2);
  });

  test("a fork resumes later under its own id with its own history, and an anchor the runtime cannot find fails the open", async () => {
    if (subject === undefined || env === null || reopen === null) { return; }
    const again = await reopen({ resume: opened.first?.id ?? "" });
    expect(again.id).toBe(opened.first?.id);
    await expect(runTurn(again, "again FORK-Q-AGAIN")).resolves.toMatchObject({ kind: "completed" });
    await again.dispose();
    const history = JSON.stringify(historyOf(requestWith(env, "FORK-Q-AGAIN")));
    expect(history).toMatch(/FORK-APPLE[\s\S]*FORK-Q-FIRST/u);
    expect(history).not.toContain("FORK-BANANA");
    await expect(reopen({ resume: run.sourceId, fork: { through: "00000000-0000-4000-8000-000000000000" } })).rejects.toThrow(/00000000-0000-4000-8000-000000000000/u);
  }, 120_000);
  test("a fork through the fork's copy of a source turn: the copied turn keeps the source's anchor", async () => {
    if (env === null || reopen === null) { return; }
    const copy = await reopen({ resume: opened.first?.id ?? "", fork: { through: run.firstAnchor } });
    await expect(runTurn(copy, "which words? FORK-Q-COPY")).resolves.toMatchObject({ kind: "completed" });
    await copy.dispose();
    expect(historyOf(requestWith(env, "FORK-Q-COPY"))).toEqual(historyOf(sourceBananaRequest));
  }, 120_000);

  // Claude: an aborted turn gets no anchor (a fork through the interrupted tool_use loses the interruption).
  test("anchors on failed and aborted turns: a fork through one carries what the source's next prompt carried", async () => {
    if (subject === undefined || env === null || reopen === null) { return; }
    const scripted = env;
    const source = await reopen({});
    await expect(runTurn(source, "remember FORK-APPLE")).resolves.toMatchObject({ kind: "completed" });
    await abortedTurn(source);
    await expect(runTurn(source, "please FORK-FAIL")).resolves.toMatchObject({ kind: "failed" });
    await runTurn(source, "which words? FORK-Q-AFTER-FAIL");
    const turns = endedTurns(source.records());
    await source.dispose();
    expect(turns.map((turn) => turn.outcome?.kind)).toEqual(["completed", "aborted", "failed", expect.any(String)]);
    const [, aborted, failed] = turns;
    expect(typeof failed?.forkAnchor).toBe("string");
    const ask = async (through: string, question: string): Promise<Turn[]> => {
      const fork = await reopen?.({ resume: source.id, fork: { through } });
      if (fork === undefined) { throw new Error("no fork"); }
      await runTurn(fork, question);
      await fork.dispose();
      return historyOf(requestWith(scripted, question));
    };
    expect(await ask(failed?.forkAnchor ?? "", "which words? FORK-Q-FAILED")).toEqual(historyOf(requestWith(scripted, "FORK-Q-AFTER-FAIL")));
    if (subject.runtime.id === "claude") {
      expect(aborted?.forkAnchor).toBeUndefined();
      // Why: a fork through the interrupted tool_use (read from the native frame) loses
      // the saved interruption; claude answers the dangling call as an internal error.
      const toolUse = source.records().find((record) => record.kind === "frame" && record.body.type === "assistant" && JSON.stringify(record.body.native).includes("call-wait"));
      const uuid = toolUse?.kind === "frame" ? asRecord(toolUse.body.native)?.uuid : undefined;
      const lost = JSON.stringify(await ask(String(uuid), "which words? FORK-Q-ABORTED")) + JSON.stringify(requestWith(scripted, "FORK-Q-ABORTED"));
      expect(lost).toContain("Tool result missing due to internal error");
      expect(lost).not.toContain("Request interrupted by user");
    } else {
      expect(await ask(aborted?.forkAnchor ?? "", "which words? FORK-Q-ABORTED")).toEqual(historyOf(requestWith(scripted, "please FORK-FAIL", "first")));
    }
  }, 180_000);

  // [env] codex 0.169.0: thread/fork does not keep the source's model and effort, config override or not.
  test.skipIf(backend !== "codex-aimock")("a codex fork runs the configured default model unless model and effort are given", async () => {
    if (reopen === null) { return; }
    const source = await reopen({ model: "gpt-5.2", effort: "high" });
    await expect(runTurn(source, "remember FORK-APPLE")).resolves.toMatchObject({ kind: "completed" });
    await source.dispose();
    expect(settings(source.records())).toEqual(["model gpt-5.2", "effort high"]);
    const plain = await reopen({ resume: source.id, fork: {}, mcpServers: [ECHO] });
    await plain.dispose();
    expect(settings(plain.records())).toEqual(["model gpt-5.1"]);
    const given = await reopen({ resume: source.id, fork: {}, mcpServers: [ECHO], model: "gpt-5.2", effort: "high" });
    await given.dispose();
    expect(settings(given.records())).toEqual(["model gpt-5.2", "effort high"]);
  }, 120_000);
});
