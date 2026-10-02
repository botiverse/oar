import { afterEach, expect, test, vi } from "vitest";
import { claudeModelRefusal } from "../../packages/oar/src/runtimes/claude/model.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.284" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** claude 2.1.284's alias table, as its `list_models` answer names it (rows carry no `[1m]` suffix). */
const aliases = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8" },
];

type Answer = Record<string, unknown> | { readonly error: string };

/**
 * A scripted claude that answers the open's read-backs the way 2.1.284 does:
 * `get_settings` with the `applied` block next to the merged settings (an
 * `env` secret standing in for a user's), `list_models` with the alias table.
 * Both are answered only once both were asked, so the test also pins that
 * the adapter asks them together.
 */
function answerFrame(subtype: string, requestId: unknown, body: Answer): string {
  const response = "error" in body
    ? { subtype: "error", request_id: requestId, error: body.error }
    : { subtype: "success", request_id: requestId, response: subtype === "get_settings"
        ? { effective: { env: { SECRET_TOKEN: "do-not-record" } }, sources: [], applied: body }
        : body };
  return frame({ type: "control_response", response });
}

function scriptedClaude(applied: Answer, listed?: Answer): FakeLineProcess {
  const asked = new Map<string, unknown>();
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    const subtype = asRecord(message?.request)?.subtype;
    if (message?.type !== "control_request" || (subtype !== "get_settings" && subtype !== "list_models")) {
      return;
    }
    asked.set(subtype, message.request_id);
    if (asked.size === 2) {
      process.emit(answerFrame("get_settings", asked.get("get_settings"), applied));
      process.emit(answerFrame("list_models", asked.get("list_models"), listed ?? { models: aliases }));
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function argv(): readonly string[] {
  return spawnLineProcess.mock.calls[0]?.[1] ?? [];
}

function subtypes(fake: FakeLineProcess): unknown[] {
  return fake.written.map((text) => asRecord(asRecord(JSON.parse(text))?.request)?.subtype);
}

// claude says nothing about the model in the stream until a turn starts; the
// open's read-back confirms the request, and Session.model is the `model` of
// each system/init frame (what the turns actually ran).
test("Session.model is null until claude's system/init frame and then reports its model", async () => {
  const fake = scriptedClaude({ model: "requested-y" });
  const session = await claudeSession(installation, { cwd: "/work", model: "requested-y" });
  expect(argv()).toContain("requested-y");
  expect(session.model().value).toBeNull();

  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-x-real", tools: [] }));
  expect(session.model().value).toBe("claude-x-real");
  await session.dispose();
});

test("Session.model follows a later system/init frame", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-x-real", tools: [] }));
  fake.emit(frame({ type: "system", subtype: "init", session_id: session.id, model: "claude-z-later", tools: [] }));
  expect(session.model().value).toBe("claude-z-later");
  await session.dispose();
});

test("without a model or effort nothing is asked", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  expect(argv()).not.toContain("--model");
  expect(fake.written).toEqual([]);
  await session.dispose();
});

test.each([
  { name: "the same name", model: "claude-opus-4-8", applied: "claude-opus-4-8" },
  { name: "an alias resolved per list_models", model: "sonnet", applied: "claude-sonnet-5-5" },
  { name: "an alias with its [1m] suffix kept", model: "sonnet[1m]", applied: "claude-sonnet-5-5[1m]" },
  { name: "the default alias", model: "default", applied: "claude-opus-5-5" },
])("a model on a resume is --model, confirmed by get_settings: $name", async ({ model, applied }) => {
  const fake = scriptedClaude({ model: applied });
  const resumed = await claudeSession(installation, { cwd: "/work", resume: "earlier-id", model });
  expect(argv()).toEqual(expect.arrayContaining(["--resume", "earlier-id", "--model", model]));
  expect(subtypes(fake)).toEqual(["get_settings", "list_models"]);
  expect(resumed.id).toBe("earlier-id");
  await resumed.dispose();
});

test("the read-back answers never enter the stream", async () => {
  scriptedClaude({ model: "claude-sonnet-5-5", effort: "low" });
  const session = await claudeSession(installation, { cwd: "/work", model: "sonnet", effort: "low" });
  expect(session.records()).toEqual([]);
  expect(JSON.stringify(session.records())).not.toContain("do-not-record");
  await session.dispose();
});

test.each([
  {
    name: "a setting that replaces the model (an availableModels allowlist)",
    model: "sonnet",
    applied: { model: "claude-opus-5-5" },
    message: "claude runs claude-opus-5-5 although model sonnet was requested",
  },
  {
    name: "a dropped [1m] suffix",
    model: "sonnet[1m]",
    applied: { model: "claude-sonnet-5-5" },
    message: "claude runs claude-sonnet-5-5 although model sonnet[1m] was requested",
  },
  {
    name: "an alias list_models cannot resolve",
    model: "sonnet",
    applied: { model: "claude-sonnet-5-5" },
    listed: { error: "unsupported control request" },
    message: "claude runs claude-sonnet-5-5 although model sonnet was requested",
  },
  {
    name: "a failed read-back",
    model: "sonnet",
    applied: { error: "get_settings is not available on this connection" },
    message: "claude could not report the model it runs (get_settings: get_settings is not available on this connection), so model sonnet cannot be confirmed",
  },
  {
    name: "a wrong model and a wrong effort, both named",
    model: "sonnet",
    effort: "low",
    applied: { model: "claude-opus-5-5", effort: "medium" },
    message: "claude runs claude-opus-5-5 although model sonnet was requested; claude applies effort medium for claude-opus-5-5 although low was requested",
  },
])("the open is refused, and claude stopped, on $name", async ({ model, effort, applied, listed, message }) => {
  const fake = scriptedClaude(applied, listed);
  await expect(claudeSession(installation, { cwd: "/work", resume: "earlier-id", model, ...(effort === undefined ? {} : { effort }) }))
    .rejects.toThrow(message);
  expect(fake.killed()).toBe(true);
});

test("claude exiting before it answers refuses the open", async () => {
  const fake = fakeLineProcess((text, process) => {
    if (text.includes("list_models")) {
      process.end(1);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeSession(installation, { cwd: "/work", model: "sonnet" })).rejects.toThrow(
    "claude exited (code 1) before answering get_settings, so model sonnet cannot be confirmed",
  );
});

// claude replays the system prompt it snapshotted at the session's start and
// ignores new prompt flags on --resume unless the snapshot is turned off.
test.each([
  { name: "a resume with a system prompt", options: { resume: "earlier-id", systemPrompt: "s" }, off: true },
  { name: "a resume with an appended prompt", options: { resume: "earlier-id", appendSystemPrompt: "a" }, off: true },
  { name: "a resume without a prompt", options: { resume: "earlier-id" }, off: false },
  { name: "a new session with a prompt", options: { systemPrompt: "s", appendSystemPrompt: "a" }, off: false },
])("--system-prompt-snapshot off comes with $name: $off", async ({ options, off }) => {
  spawnLineProcess.mockReturnValue(fakeLineProcess());
  const session = await claudeSession(installation, { cwd: "/work", ...options });
  const flags = argv();
  const at = flags.indexOf("--system-prompt-snapshot");
  expect(at === -1 ? null : flags[at + 1]).toBe(off ? "off" : null);
  await session.dispose();
});

function settings(applied: Record<string, unknown>): Record<string, unknown> {
  return { type: "control_response", response: { subtype: "success", request_id: "r", response: { effective: {}, sources: [], applied } } };
}

const listed = { type: "control_response", response: { subtype: "success", request_id: "l", response: { models: aliases } } };

test("claudeModelRefusal accepts the name or its list_models resolution, and says what claude runs instead", () => {
  expect(claudeModelRefusal("haiku", settings({ model: "claude-haiku-4-5-20251001" }), listed)).toBeNull();
  expect(claudeModelRefusal("opus[1m]", settings({ model: "claude-opus-5-5[1m]" }), listed)).toBeNull();
  expect(claudeModelRefusal("bogus-model-x", settings({ model: "bogus-model-x" }), new Error("unasked"))).toBeNull();
  expect({
    replaced: claudeModelRefusal("haiku", settings({ model: "claude-opus-5-5" }), listed),
    unresolved: claudeModelRefusal("haiku", settings({ model: "claude-haiku-4-5-20251001" }), new Error("claude did not answer list_models")),
    unreported: claudeModelRefusal("haiku", settings({ effort: "low" }), listed),
    failed: claudeModelRefusal("haiku", { type: "control_response", response: { subtype: "error", request_id: "r", error: "nope" } }, listed),
  }).toMatchInlineSnapshot(`
    {
      "failed": "claude could not report the model it runs (get_settings: nope), so model haiku cannot be confirmed",
      "replaced": "claude runs claude-opus-5-5 although model haiku was requested",
      "unreported": "claude's get_settings answer names no applied model, so model haiku cannot be confirmed",
      "unresolved": "claude runs claude-haiku-4-5-20251001 although model haiku was requested",
    }
  `);
});
