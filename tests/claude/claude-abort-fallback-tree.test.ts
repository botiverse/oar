import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { createAbortFallback } from "../../packages/oar/src/shared/abort-fallback.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeAgentBinary, gone, withTreeProbe } from "../fixtures/process-tree.js";

// The fallback's ten seconds, shortened; the kill it triggers is the real one.
vi.mock("../../packages/oar/src/shared/abort-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<{ createAbortFallback: typeof createAbortFallback }>();
  return { createAbortFallback: (kill: () => void) => actual.createAbortFallback(kill, 200) };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// oar#210: a claude that cannot answer the interrupt is ended by the abort
// fallback, and the Bash tool command it was running, in a session of its
// own, must end with it. A real process tree: the stand-in claude ignores the
// interrupt and SIGTERM, and runs its tool out of its process group.
test.skipIf(process.platform === "win32")("the abort fallback ends a stuck claude's tool that left its process group", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "300");
  await withTreeProbe({ ignoreSigterm: true, detachTool: true }, async (probe) => {
    const session = await claudeSession(
      { kind: "available", via: "executable", command: fakeAgentBinary(probe.dir) },
      { cwd: probe.dir, env: probe.env },
    );
    try {
      const tree = await probe.tree();
      const prompt = await session.prompt("run the tool");
      assert.equal(prompt.response.body.kind, "accepted");
      const abort = await session.abort();
      assert.deepEqual(abort.response.body, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
      assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild, 1000)], [true, true], "claude and its tool are gone");
    } finally {
      await session.dispose();
    }
  });
});
