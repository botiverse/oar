/* oxlint-disable eslint/max-statements -- Each test drives one DSH bridge fault or observer race. */
import { afterEach, expect, test, vi } from "vitest";
import { DSH_BRIDGE_PROTOCOL } from "../../packages/oar/src/runtimes/dsh/bridge.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

interface LaunchResult { readonly child: FakeLineProcess; readonly directory: { readonly path: string; remove(): void } }
const launchDsh = vi.fn<() => Promise<LaunchResult>>();
vi.mock("../../packages/oar/src/runtimes/dsh/launch.js", async (original) => ({
  ...await original<Record<string, unknown>>(),
  launchDsh: async (): Promise<LaunchResult> => launchDsh(),
}));

const { dshSession } = await import("../../packages/oar/src/runtimes/dsh/session.js");
const installation = { kind: "available", via: "executable", command: "/fake/dsh", version: "0.2.1-rc.5" } as const;

afterEach(() => { vi.useRealTimers(); launchDsh.mockReset(); });

async function openFakeDsh(onCommand?: (message: Record<string, unknown>, emit: (value: unknown) => void, end: (code: number | null) => void) => boolean) {
  let sessionId = "";
  const child = fakeLineProcess((line, proc) => {
    const message = asRecord(JSON.parse(line));
    if (message === null || typeof message.id !== "string" || typeof message.method !== "string") { return; }
    const emit = (value: unknown): void => { proc.emit(`${JSON.stringify(value)}\n`); };
    if (message.method === "open") {
      sessionId = typeof message.sessionId === "string" ? message.sessionId : "s";
      emit({ type: "response", id: message.id, result: { sessionId, model: "local/plain", imageTypes: [], methods: { steer: true }, inboxMethods: { remove: true } } });
      return;
    }
    if (onCommand?.(message, emit, (code) => { proc.end(code); }) === true) { return; }
    emit({ type: "response", id: message.id, result: {} });
  });
  launchDsh.mockResolvedValueOnce({ child, directory: { path: "/tmp/dsh", remove() {} } });
  const opening = dshSession(installation, { cwd: "/work" });
  setImmediate(() => { child.emit(`${JSON.stringify({ type: "ready", protocol: DSH_BRIDGE_PROTOCOL, services: {} })}\n`); });
  const session = await opening;
  return { session, child, sessionId };
}

test("DSH in-flight RPC when process exits rejects with runtime_exited, not error", async () => {
  const { session } = await openFakeDsh((message, _emit, end) => {
    if (message.method === "prompt") { queueMicrotask(() => { end(1); }); return true; }
    return false;
  });
  try {
    const result = await session.prompt("crash");
    expect(result.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  } finally { await session.dispose(); }
});

test("DSH clears abort fallback before publishing turn_ended so a synchronous observer's new abort stays armed", async () => {
  const { session, child, sessionId } = await openFakeDsh((message, emit) => {
    if (message.method === "prompt") {
      emit({ type: "response", id: message.id, result: {} });
      emit({ type: "native", channel: "session/event", sessionId: message.sessionId, event: { type: "turn/start", data: {} } });
      return true;
    }
    return false;
  });
  const kill = vi.spyOn(child, "kill");
  try {
    await session.prompt("first");
    vi.useFakeTimers();
    let rearmed = false;
    session.rawEvents((record) => {
      if (!rearmed && record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended")) {
        rearmed = true;
        void session.abort();
      }
    });
    child.emit(`${JSON.stringify({ type: "native", channel: "session/event", sessionId, event: { type: "turn/end", data: { reason: { kind: "completed" } } } })}\n`);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(rearmed).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    child.end(0);
    await session.dispose();
  }
});

test("DSH idle steer with images answers no_active_turn before unsupported", async () => {
  const { session } = await openFakeDsh();
  try {
    const result = await session.steer?.("hello", { images: [{ path: "/nonexistent.png" }] });
    expect(result?.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  } finally { await session.dispose(); }
});
