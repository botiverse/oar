import { afterEach, expect, test, vi } from "vitest";
import { RuntimeFailureError, SessionNotFoundError } from "../../packages/oar/src/index.js";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

const installation = { kind: "available", via: "executable", command: "codex" } as const;

interface Request { readonly method: string; readonly params: JsonRecord }

/**
 * A scripted app-server reporting `version` in its initialize userAgent. The
 * open is answered by `open` (a result or a JSON-RPC error); everything else
 * with `{}`, `thread/settings/update` followed by its report.
 */
type Answer = (request: Request) => { readonly result?: JsonRecord; readonly error?: JsonRecord };

function answerFor(version: string | null, open: Answer, request: Request): object {
  if (request.method === "initialize") { return { result: version === null ? {} : { userAgent: `codex_cli_rs/${version} (Linux; x86_64)` } }; }
  return ["thread/start", "thread/resume", "thread/fork"].includes(request.method) ? open(request) : { result: {} };
}

function appServer(version: string | null, open: Answer): { fake: FakeLineProcess; requests: Request[] } {
  const requests: Request[] = [];
  const fake = fakeLineProcess((text, child) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    const request = { method: message.method, params: asRecord(message.params) ?? {} };
    requests.push(request);
    child.emit(`${JSON.stringify({ id: message.id, ...answerFor(version, open, request) })}\n`);
    if (request.method === "thread/settings/update") {
      child.emit(`${JSON.stringify({ method: "thread/settings/updated", params: { threadId: "fork-thread", threadSettings: { effort: request.params.effort } } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return { fake, requests };
}

const forked: Answer = () => ({ result: { thread: { id: "fork-thread", name: "Source name" }, model: "gpt-5.5", reasoningEffort: "low" } });
const open = async (options: Partial<SessionOptions>, version: string | null = "0.169.0", answer: Answer = forked) => {
  const server = appServer(version, answer);
  const opening = codexSession(installation, { cwd: "/work", resume: "source-thread", ...options });
  return { ...server, opening };
};

test("a fork sends thread/fork for the source through lastTurnId, and the Session is the new thread", async () => {
  const { requests, opening } = await open({ fork: { through: "turn-1" } });
  const session = await opening;
  expect(session.id).toBe("fork-thread");
  const fork = requests.find((request) => request.method === "thread/fork");
  expect(fork?.params).toEqual({ threadId: "source-thread", lastTurnId: "turn-1", excludeTurns: true, cwd: "/work", approvalPolicy: "never" });
  expect(requests.map((request) => request.method)).not.toContain("thread/resume");
  expect(session.records().some((record) => record.kind === "frame" && record.body.type === "thread/fork")).toBe(true);
  await session.dispose();
});

test("a fork without through copies the whole thread: no lastTurnId, and any codex version", async () => {
  const { requests, opening } = await open({ fork: {} }, "0.142.5");
  const session = await opening;
  expect(requests.find((request) => request.method === "thread/fork")?.params).not.toHaveProperty("lastTurnId");
  await session.dispose();
});

// The 0.142.5 app-server schema has no lastTurnId and serde ignores the
// unknown field, so the fork would silently copy the whole thread.
test.each([["0.142.5"], [null]])("through on codex %s is runtime_outdated before any fork is sent", async (version) => {
  const { fake, requests, opening } = await open({ fork: { through: "turn-1" } }, version);
  const failure: unknown = await opening.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RuntimeFailureError);
  expect(failure).toMatchObject({ code: "runtime_outdated", message: `Codex ${version ?? "(version unreported)"} has no thread/fork lastTurnId, which OAR needs to fork through a turn (SessionOptions.fork.through); update Codex to 0.143.0 or newer` });
  expect(requests.map((request) => request.method)).toEqual(["initialize"]);
  expect(fake.killed()).toBe(true);
});

test("a fork's effort is set on the new thread after the reply, as on a resume, and model/mcp ride on the fork", async () => {
  const { requests, opening } = await open({ fork: {}, effort: "high", model: "gpt-5.5", mcpServers: [{ name: "local", command: "/bin/echo" }] });
  const session = await opening;
  const fork = requests.find((request) => request.method === "thread/fork");
  expect(fork?.params).toMatchObject({ model: "gpt-5.5", config: { mcp_servers: { local: { command: "/bin/echo", args: [], enabled: true } } } });
  expect(JSON.stringify(fork?.params)).not.toContain("model_reasoning_effort");
  expect(requests.find((request) => request.method === "thread/settings/update")?.params).toEqual({ threadId: "fork-thread", effort: "high" });
  await session.dispose();
});

test("a fork is a new thread, so a given name is set even when the copy carries one", async () => {
  const { requests, opening } = await open({ fork: {}, name: "Branch" });
  const session = await opening;
  expect(requests.find((request) => request.method === "thread/name/set")?.params).toEqual({ threadId: "fork-thread", name: "Branch" });
  await session.dispose();
});

test("a fork that answers with its source thread is refused", async () => {
  const { fake, opening } = await open({ fork: {} }, "0.169.0", () => ({ result: { thread: { id: "source-thread" } } }));
  await expect(opening).rejects.toThrow("codex thread/fork answered with its source thread source-thread, not a new one");
  expect(fake.killed()).toBe(true);
});

// [env] codex 0.169.0, scripted provider (sea-trial/vendor/session-fork.vendor.test.ts).
test("a missing source is SessionNotFoundError, an unknown turn keeps codex's words", async () => {
  const missing = { code: -32_600, message: "no rollout found for thread id source-thread" };
  const gone = await open({ fork: {} }, "0.169.0", () => ({ error: missing }));
  const failure: unknown = await gone.opening.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ sessionId: "source-thread", message: "codex thread/fork failed: no rollout found for thread id source-thread", cause: { method: "thread/fork", native: missing } });
  spawnLineProcess.mockReset();
  const unknown = { code: -32_600, message: "turn not found: turn-9" };
  const turn = await open({ fork: { through: "turn-9" } }, "0.169.0", () => ({ error: unknown }));
  await expect(turn.opening).rejects.toMatchObject({ message: "codex thread/fork failed: turn not found: turn-9", cause: { method: "thread/fork", native: unknown } });
});

test("a root turn's end carries its turn id as the fork anchor; a child thread's does not", () => {
  const state = initialCodexProjection("root");
  const anchorOf = (threadId: string): unknown => {
    const [command] = foldCodexNotification(state, "turn/completed", { threadId, turn: { id: `turn-of-${threadId}`, status: "completed" } }).commands;
    return command?.kind === "frame" ? command.body.events : null;
  };
  expect(anchorOf("root")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" }, forkAnchor: "turn-of-root" }]);
  expect(anchorOf("child")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
});

// [env] codex 0.169.0: the fork's thread total includes the source's turns, and is not re-reported before its first turn.
test("a fork awaits a token baseline like a resume, so its totals stay unknown without one", () => {
  expect(initialCodexProjection("root", "thread/fork").tokenBaseline).toEqual(initialCodexProjection("root", "thread/resume").tokenBaseline);
  expect(initialCodexProjection("root", "thread/fork").tokenBaseline).not.toEqual(initialCodexProjection("root", "thread/start").tokenBaseline);
});
