import { afterEach, expect, test, vi } from "vitest";
import { claudeEffortRefusal } from "../../packages/oar/src/runtimes/claude/effort.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.284" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * A scripted claude that answers the `get_settings` read-back the way 2.1.284
 * does: SessionStart hook frames first, then the control_response whose
 * `applied` block is what it will send, next to the merged settings (here an
 * `env` block standing in for a user's secrets).
 */
function scriptedClaude(applied: Record<string, unknown> | { readonly error: string }): FakeLineProcess {
  // oxlint-disable-next-line eslint/max-statements -- Script the initialization and settings answers on the same process.
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    const request = asRecord(message?.request);
    if (message?.type === "control_request" && request?.subtype === "initialize") {
      process.emit(line({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }));
      return;
    }
    if (message?.type === "control_request" && request?.subtype === "get_usage") {
      process.emit(line({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { session: { model_usage: {} } } } }));
      return;
    }
    if (message?.type !== "control_request" || request?.subtype !== "get_settings") {
      return;
    }
    process.emit(line({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }));
    process.emit(line({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "" }));
    const response = "error" in applied
      ? { subtype: "error", request_id: message.request_id, error: applied.error }
      : {
          subtype: "success",
          request_id: message.request_id,
          response: {
            effective: { env: { SECRET_TOKEN: "do-not-record" } },
            sources: [{ source: "userSettings", settings: { env: { SECRET_TOKEN: "do-not-record" } } }],
            applied,
          },
        };
    process.emit(line({ type: "control_response", response }));
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function argv(): readonly string[] {
  return spawnLineProcess.mock.calls[0]?.[1] ?? [];
}

test("effort is --effort on a new session, confirmed by claude's get_settings before the session opens", async () => {
  const fresh = scriptedClaude({ model: "claude-opus-5-5[1m]", effort: "low" });
  const session = await claudeSession(installation, { cwd: "/work", effort: "low" });
  expect(argv()).toEqual(expect.arrayContaining(["--effort", "low", "--session-id", session.id]));
  expect(fresh.written.map((text) => asRecord(asRecord(JSON.parse(text))?.request)?.subtype)).toEqual(["get_settings"]);
  await session.dispose();
});

test("effort is --effort on a resume too, confirmed the same way", async () => {
  scriptedClaude({ model: "claude-opus-5-5[1m]", effort: "high" });
  const resumed = await claudeSession(installation, { cwd: "/work", resume: "earlier-id", effort: "high" });
  expect(argv()).toEqual(expect.arrayContaining(["--resume", "earlier-id", "--effort", "high"]));
  expect(resumed.id).toBe("earlier-id");
  await resumed.dispose();
});

// The read-back's answer dumps the merged settings of every source, env
// included: it is consumed, never recorded, while claude's other frames are.
test("the get_settings answer never enters the stream; the hook frames around it do, and claude reports no effort", async () => {
  scriptedClaude({ model: "claude-opus-5-5[1m]", effort: "low" });
  const session = await claudeSession(installation, { cwd: "/work", effort: "low" });
  const records = session.records();
  expect(records.map((record) => (record.kind === "frame" ? record.body.type : record.kind))).toEqual([
    "system/hook_started",
    "system/hook_response",
  ]);
  expect(JSON.stringify(records)).not.toContain("do-not-record");
  expect(session.effort().value).toBeNull();
  await session.dispose();
});

test("without an effort nothing extra is asked: no --effort, no get_settings", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  expect(argv()).not.toContain("--effort");
  expect(fake.written).toEqual([]);
  await session.dispose();
});

test.each([
  {
    name: "an unknown level claude drops with a stderr warning",
    effort: "bogus",
    applied: { model: "claude-opus-5-5[1m]", effort: "medium" },
    message: "claude applies effort medium for claude-opus-5-5[1m] although bogus was requested",
  },
  {
    name: "a model that takes no effort",
    effort: "low",
    applied: { model: "claude-haiku-4-5-20251001", effort: null },
    message: "claude sends no effort for claude-haiku-4-5-20251001 (the model takes none), so effort low would be dropped",
  },
  {
    name: "a failed read-back",
    effort: "low",
    applied: { error: "get_settings is not available on this connection" },
    message: "claude could not report the effort it runs (get_settings: get_settings is not available on this connection), so effort low cannot be confirmed",
  },
])("the open is refused, and claude stopped, on $name", async ({ effort, applied, message }) => {
  const fake = scriptedClaude(applied);
  await expect(claudeSession(installation, { cwd: "/work", effort })).rejects.toThrow(message);
  expect(fake.killed()).toBe(true);
});

test("claude exiting before it answers refuses the open", async () => {
  const fake = fakeLineProcess((text, process) => {
    if (text.includes("get_settings")) {
      process.end(1);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeSession(installation, { cwd: "/work", effort: "low" })).rejects.toThrow(
    "claude exited (code 1) before answering get_settings, so effort low cannot be confirmed",
  );
});

function answer(response: Record<string, unknown>): Record<string, unknown> {
  return { type: "control_response", response };
}

function success(applied: Record<string, unknown>): Record<string, unknown> {
  return answer({ subtype: "success", request_id: "r", response: { effective: {}, sources: [], applied } });
}

test("claudeEffortRefusal reads applied.effort and says what claude would run instead", () => {
  expect(claudeEffortRefusal("low", success({ model: "claude-sonnet-5-5", effort: "low" }))).toBeNull();
  expect({
    ignored: claudeEffortRefusal("bogus", success({ model: "claude-opus-5-5[1m]", effort: "medium" })),
    dropped: claudeEffortRefusal("low", success({ model: "claude-haiku-4-5-20251001", effort: null })),
    unreported: claudeEffortRefusal("low", success({ model: "claude-opus-5-5[1m]" })),
    failed: claudeEffortRefusal("low", answer({ subtype: "error", request_id: "r", error: "unsupported control request" })),
  }).toMatchInlineSnapshot(`
    {
      "dropped": "claude sends no effort for claude-haiku-4-5-20251001 (the model takes none), so effort low would be dropped",
      "failed": "claude could not report the effort it runs (get_settings: unsupported control request), so effort low cannot be confirmed",
      "ignored": "claude applies effort medium for claude-opus-5-5[1m] although bogus was requested",
      "unreported": "claude's get_settings answer names no applied effort, so effort low cannot be confirmed",
    }
  `);
});
