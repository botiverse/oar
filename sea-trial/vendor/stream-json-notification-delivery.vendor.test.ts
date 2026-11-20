import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, onTestFinished, test, vi } from "vitest";
import { claudeRuntime, qoderRuntime, type Session } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { qoderFixture } from "./support/qoder-fixture.js";
import { runTurn } from "./support/asserts.js";

const backend = process.env.OAR_TEST;
type Phase = "tool" | "text";
function shell(marker: string, background: boolean) {
  return { name: "Bash", args: { command: `for i in {1..300}; do if [ -f ${marker} ]; then echo finished; exit 0; fi; sleep 0.1; done; exit 1`,
    description: marker, run_in_background: background } };
}
async function open(phase: Phase) {
  const background = shell("release-background", true);
  const foreground = shell("release-foreground", false);
  const options = { retainedBytes: 4 * 1024 * 1024 };
  if (backend === "qoder-native") {
    const fixture = await qoderFixture([{ tool: background }, { text: "parent finished" },
      phase === "tool" ? { tool: foreground } : { chunks: Array.from({ length: 10 }, () => "reply ") },
      { text: "finished" }, { text: "delivered" }], 100);
    const session = await qoderRuntime.session({ kind: "available", via: "executable", command: process.env.OAR_QODER_BIN ?? "qodercli" },
      { ...fixture.options, ...options });
    return { session, cwd: fixture.options.cwd };
  }
  let request = 0;
  const provider = await startClaudeAimock(mock => {
    mock.on({ predicate: () => true }, async () => {
      request += 1;
      const tool = request === 1 ? background : (request === 3 && phase === "tool" ? foreground : undefined);
      if (tool !== undefined) { return { toolCalls: [{ id: `call-${request}`, name: tool.name, arguments: JSON.stringify(tool.args) }] }; }
      if (request === 3) { await delay(500); }
      return { content: "finished" };
    });
  });
  onTestFinished(async () => provider.stop());
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-claude-notification-"));
  onTestFinished(async () => { await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const session = await claudeRuntime.session({ kind: "available", via: "executable", command: process.env.OAR_CLAUDE_BIN ?? "claude" },
    { ...options, cwd, model: "haiku", userConfiguration: "exclude", env: { ...provider.env, HOME: cwd, CLAUDE_CONFIG_DIR: path.join(cwd, ".claude") } });
  return { session, cwd };
}

function observeNotification(session: Session, inputId: string) {
  const observed = { activeAtInit: false, initSeen: false, toolStarted: false, ends: 0, endsBeforeEcho: -1 };
  session.rawEvents(record => {
    if (record.kind !== "frame" || record.agentPath.length > 0) { return; }
    if (record.body.type === "system/init" && observed.ends === 0) {
      observed.activeAtInit = session.status().value.kind === "running" && record.body.events.some(e => e.kind === "turn_active" && e.inputId === undefined);
      observed.initSeen = true;
    }
    for (const event of record.body.events) {
      if (event.kind === "tool_call_started") { observed.toolStarted = true; }
      if (event.kind === "user_message" && event.inputId === inputId) { observed.endsBeforeEcho = observed.ends; }
      if (event.kind === "turn_ended") { observed.ends += 1; }
    }
  });
  return observed;
}

test.skipIf(backend !== "claude-aimock" && backend !== "qoder-native").each(["tool", "text"] as const)(
  "delivery during a native background notification (%s)", async phase => {
    const { session, cwd } = await open(phase);
    const release = async (name: string) => writeFile(path.join(cwd, `release-${name}`), "done");
    try {
      expect(await runTurn(session, "start the background job")).toEqual({ kind: "completed" });
      expect(session.status().value.kind).toBe("idle");
      const inputId = randomUUID();
      const notification = observeNotification(session, inputId);
      await release("background");
      await vi.waitFor(() => { expect(notification.initSeen).toBe(true); }, { timeout: 30_000 });
      expect(notification.activeAtInit).toBe(true);
      if (phase === "tool") { await vi.waitFor(() => { expect(notification.toolStarted).toBe(true); }, { timeout: 30_000 }); }
      const delivery = await session.deliver("delivery during notification", { when: "now", inputId, origin: { kind: "notification" } });
      expect(delivery.landed).toBe("steered");
      await release("foreground");
      await vi.waitFor(() => {
        expect(notification.endsBeforeEcho).toBe(phase === "tool" ? 0 : 1);
        expect(notification.ends).toBe(phase === "tool" ? 1 : 2);
        expect(session.status().value.kind).toBe("idle");
      }, { timeout: 30_000 });
    } finally {
      await Promise.all([release("foreground"), release("background")]);
      await session.dispose();
    }
  }, 90_000);

test.skipIf(backend !== "qoder-native")("abort ends a native Qoder notification turn and permits a fresh prompt", async () => {
  const { session, cwd } = await open("tool");
  const release = async (name: string) => writeFile(path.join(cwd, `release-${name}`), "done");
  try {
    expect(await runTurn(session, "start the background job")).toEqual({ kind: "completed" });
    const notification = observeNotification(session, "");
    await release("background");
    await vi.waitFor(() => { expect(notification.toolStarted && notification.activeAtInit).toBe(true); }, { timeout: 30_000 });
    const abort = await session.abort();
    expect(abort.kind).toBe("accepted");
    await vi.waitFor(() => {
      expect(notification.ends).toBe(1);
      expect(session.status().value.kind).toBe("idle");
    }, { timeout: 15_000 });
    const result = session.records().findLast(r => r.kind === "frame" && r.body.events.some(event => event.kind === "turn_ended"));
    expect(result?.kind === "frame" && result.body.events).toContainEqual({ kind: "turn_ended", outcome: { kind: "aborted" } });
    expect(await runTurn(session, "fresh prompt after abort")).toEqual({ kind: "completed" });
  } finally {
    await Promise.all([release("foreground"), release("background")]);
    await session.dispose();
  }
}, 90_000);
