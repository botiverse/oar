import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import type { Session, SessionOptions } from "../packages/oar/src/contracts/session.js";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { killGraceMs } from "../packages/oar/src/shared/executable/index.js";
import { fixture as acpAgent, profile } from "./fixtures/acp-session-support.js";
import { agentTreeModule, fakeAgentBinary, gone, timed, withTreeProbe } from "./fixtures/process-tree.js";

type Open = (dir: string, options: SessionOptions) => Promise<Session>;

// Every adapter that owns a runtime process, driven unmodified against a
// stand-in agent that ignores SIGTERM and has started a tool of its own:
// fake-agent-process.mjs, or the scripted ACP agent with agent-tree.mjs preloaded.
const runtimes: readonly (readonly [string, Open])[] = [
  ["claude", async (dir, options) => claudeSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["codex", async (dir, options) => codexSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["acp", async (_dir, options) => acpSession(profile({ args: ["--import", agentTreeModule, acpAgent, "session"] }))(
    { kind: "available", via: "executable", command: process.execPath },
    options,
  )],
];

// POSIX: that is where the runtime process leads a process group of its own.
describe.skipIf(process.platform === "win32").concurrent("dispose takes down the runtime's whole process group", () => {
  // A short grace keeps the suite fast; the default's value is not the point.
  beforeAll(() => {
    vi.stubEnv("OAR_KILL_GRACE_MS", "500");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test.each(runtimes)("%s: settles within the grace period even when the runtime ignores SIGTERM", async (_runtime, open) => {
    await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
      const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
      const tree = await probe.tree();
      const elapsed = await timed(async () => session.dispose());
      assert.ok(elapsed < killGraceMs() + 2000, `dispose settled ${elapsed.toFixed(0)} ms after it was called`);
      const [request, response] = session.records().slice(-2);
      assert.ok(request?.kind === "request" && request.body.kind === "dispose" && response?.kind === "response", `the stream ends with the dispose and its answer: ${JSON.stringify(session.records().slice(-2))}`);
      assert.deepEqual({ requestId: response.requestId, body: response.body }, { requestId: request.id, body: { kind: "exited", code: null } }, "the observed (SIGKILLed) exit answers the dispose");
      assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild)], [true, true], "the runtime and the tool it started are gone");
    });
  });
});
