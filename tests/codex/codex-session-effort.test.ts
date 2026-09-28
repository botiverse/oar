import { afterEach, expect, test, vi } from "vitest";
import { codexResumeEffortRefusal } from "../../packages/oar/src/runtimes/codex/open.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.155.1" } as const;
const threadId = "thread-123";

afterEach(() => {
  spawnLineProcess.mockReset();
});

interface Request {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Script {
  /** The open reply's `reasoningEffort` (undefined: the field is absent). */
  readonly openEffort: (request: Request) => unknown;
  /** How a `thread/settings/update` is answered: the effort codex then pushes in `thread/settings/updated`, or an RPC error. */
  readonly settingsUpdate?: (effort: unknown) => { readonly pushed: unknown } | { readonly error: string };
}

type Emit = (message: Record<string, unknown>) => void;

/** thread/settings/update as 0.155.1 answers it: `{}`, then thread/settings/updated with the new settings (or an RPC error). */
function answerSettingsUpdate(script: Script, request: Request & { readonly id: number }, emit: Emit): void {
  const outcome = script.settingsUpdate?.(request.params.effort) ?? { pushed: request.params.effort };
  if ("error" in outcome) {
    emit({ id: request.id, error: { code: -32_600, message: outcome.error } });
    return;
  }
  emit({ id: request.id, result: {} });
  emit({ method: "thread/settings/updated", params: { threadId, threadSettings: { model: "gpt-5.5", effort: outcome.pushed } } });
}

/** How the scripted app-server answers one request: the open replies report `openEffort` as `reasoningEffort`. */
function answerRequest(script: Script, request: Request & { readonly id: number }, emit: Emit): void {
  if (request.method === "thread/settings/update") {
    answerSettingsUpdate(script, request, emit);
    return;
  }
  const effort = script.openEffort(request);
  const opened = { thread: { id: threadId }, model: "gpt-5.5", modelProvider: "openai", ...(effort === undefined ? {} : { reasoningEffort: effort }) };
  emit({ id: request.id, result: request.method === "initialize" ? {} : opened });
}

/** A scripted app-server shaped after 0.155.1; records every request so tests can assert the wire. */
function fakeAppServer(script: Script): { fake: FakeLineProcess; requests: Request[] } {
  const requests: Request[] = [];
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    const request = { id: message.id, method: message.method, params: asRecord(message.params) ?? {} };
    requests.push(request);
    answerRequest(script, request, (reply) => {
      process.emit(`${JSON.stringify(reply)}\n`);
    });
  });
  spawnLineProcess.mockReturnValue(fake);
  return { fake, requests };
}

const echoed = (request: Request): unknown => asRecord(request.params.config)?.model_reasoning_effort ?? null;

test("a new thread takes effort as its config override, and the open reply is read back", async () => {
  const { requests } = fakeAppServer({ openEffort: echoed });
  const started = await codexSession(installation, { cwd: "/work", effort: "low" });
  expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
    config: { model_reasoning_effort: "low" },
  });
  expect(requests.map((request) => request.method)).not.toContain("thread/settings/update");
  expect(started.effort().value).toBe("low");
  expect(started.records().find((record) => record.kind === "frame" && record.body.type === "thread/start")).toMatchObject({
    body: { events: [{ kind: "model", model: "gpt-5.5" }, { kind: "effort", effort: "low" }] },
  });
  await started.dispose();
});

// A config override on thread/resume would rebuild the thread's settings from
// config.toml (live 0.155.1: a resumed thread without `model` switched to the
// configured default), so a resume sets the level on the loaded thread.
test("a resume sets another level with thread/settings/update, never a config override, and reads codex's push back", async () => {
  const { requests } = fakeAppServer({ openEffort: () => "low" });
  const resumed = await codexSession(installation, { cwd: "/work", resume: threadId, effort: "high" });
  const resume = requests.find((request) => request.method === "thread/resume");
  expect(resume?.params).not.toHaveProperty("config");
  expect(requests.filter((request) => request.method === "thread/settings/update").map((request) => request.params)).toEqual([
    { threadId, effort: "high" },
  ]);
  expect(resumed.effort().value).toBe("high");
  const frames = resumed.records().filter((record): record is Extract<typeof record, { kind: "frame" }> => record.kind === "frame");
  expect(frames.map((record) => [record.body.type, record.body.events])).toEqual([
    ["thread/resume", [{ kind: "model", model: "gpt-5.5" }, { kind: "effort", effort: "low" }]],
    ["thread/settings/updated", [{ kind: "model", model: "gpt-5.5" }, { kind: "effort", effort: "high" }]],
  ]);
  await resumed.dispose();
});

test("a resume already running the requested level asks nothing more", async () => {
  const { requests } = fakeAppServer({ openEffort: () => "high" });
  const resumed = await codexSession(installation, { cwd: "/work", resume: threadId, effort: "high" });
  expect(requests.map((request) => request.method)).toEqual(["initialize", "thread/resume"]);
  expect(resumed.effort().value).toBe("high");
  await resumed.dispose();
});

// codex persists the level with the thread: a resume that asks for none runs
// the level the thread last ran with, and says so.
test("without an effort nothing extra is sent, and effort() is whatever codex reports", async () => {
  const { requests } = fakeAppServer({ openEffort: () => "high" });
  const resumed = await codexSession(installation, { cwd: "/work", resume: threadId });
  expect(requests.find((request) => request.method === "thread/resume")?.params).not.toHaveProperty("config");
  expect(resumed.effort().value).toBe("high");
  await resumed.dispose();

  fakeAppServer({ openEffort: () => null });
  const fresh = await codexSession(installation, { cwd: "/work" });
  expect(fresh.effort().value).toBeNull();
  await fresh.dispose();
});

const reports = (effort: unknown) => (): unknown => effort;

test.each([
  { name: "thread/start keeps another level", script: { openEffort: reports("medium") }, resume: undefined, message: "codex thread/start kept effort medium although effort low was requested" },
  { name: "thread/start reports no explicit level", script: { openEffort: reports(null) }, resume: undefined, message: "codex thread/start kept effort none (the model's default) although effort low was requested" },
  { name: "the reply has no reasoningEffort at all", script: { openEffort: reports(undefined) }, resume: undefined, message: "codex thread/start reports no reasoningEffort although effort low was requested" },
  { name: "codex refuses the settings update", script: { openEffort: reports("medium"), settingsUpdate: () => ({ error: "thread not loaded" }) }, resume: threadId, message: "codex thread/settings/update effort=low failed: thread not loaded" },
  { name: "codex pushes another level", script: { openEffort: reports("medium"), settingsUpdate: () => ({ pushed: "medium" }) }, resume: threadId, message: "codex thread/settings/update left effort medium although low was requested" },
] satisfies readonly { readonly name: string; readonly script: Script; readonly resume: string | undefined; readonly message: string }[])(
  "the open is refused, and the app-server stopped, when $name",
  async ({ script, resume, message }) => {
    const { fake } = fakeAppServer(script);
    await expect(codexSession(installation, { cwd: "/work", effort: "low", ...(resume === undefined ? {} : { resume }) })).rejects.toThrow(message);
    expect(fake.killed()).toBe(true);
  },
);

test("codexResumeEffortRefusal refuses a resume codex never confirms", () => {
  expect(codexResumeEffortRefusal("low", null, { threadSettings: { effort: "low" } })).toBeNull();
  expect(codexResumeEffortRefusal("low", null, null)).toBe(
    "codex reported no thread/settings/updated within 10000 ms, so effort low cannot be confirmed",
  );
});

test("thread/settings/updated is codex's own report of the model and effort a settings change set", () => {
  const params = {
    threadId,
    threadSettings: { cwd: "/work", model: "gpt-5.5", modelProvider: "openai", effort: "low", summary: null },
  };
  const { commands } = foldCodexNotification(initialCodexProjection(threadId), "thread/settings/updated", params);
  expect(commands).toEqual([{
    kind: "frame",
    body: { type: "thread/settings/updated", native: params, events: [{ kind: "model", model: "gpt-5.5" }, { kind: "effort", effort: "low" }] },
  }]);
  const cleared = { threadId, threadSettings: { model: "gpt-5.5", effort: null } };
  expect(foldCodexNotification(initialCodexProjection(threadId), "thread/settings/updated", cleared).commands[0]).toMatchObject({
    body: { events: [{ kind: "model", model: "gpt-5.5" }] },
  });
});
