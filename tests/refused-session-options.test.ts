import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import type { AvailableInstallation } from "../packages/oar/src/contracts/installation.js";
import type { RefusableSessionOption } from "../packages/oar/src/contracts/runtime.js";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { defineRuntime, runtimes } from "../packages/oar/src/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";

const given: Readonly<Record<RefusableSessionOption, Partial<SessionOptions>>> = {
  systemPrompt: { systemPrompt: "x" },
  appendSystemPrompt: { appendSystemPrompt: "x" },
  env: { env: { OAR_PROBE: "1" } },
};

// Declared refusals are checked before anything starts, so an installation
// that points nowhere is enough: the open must reject with the declared reason.
function nowhere(id: string): AvailableInstallation {
  return id === "pi" || id === "cursor" ? { kind: "available", via: "bundled" } : { kind: "available", via: "executable", command: "/nonexistent/oar-probe" };
}

test("every declared refusal is what session() rejects with", async () => {
  const declaring = runtimes.list().filter((runtime) => runtime.refusedSessionOptions !== undefined);
  assert.deepEqual(declaring.map((runtime) => runtime.id).toSorted(), ["antigravity", "cursor", "kimi"]);
  for (const runtime of declaring) {
    const keys = (["systemPrompt", "appendSystemPrompt", "env"] as const).filter((key) => runtime.refusedSessionOptions?.[key] !== undefined);
    for (const key of keys) {
      const options = { cwd: "/tmp", ...given[key] };
      // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
      await expect(runtime.session(nowhere(runtime.id), options), `${runtime.id} ${key}`).rejects.toThrow(runtime.refusedSessionOptions?.[key]);
    }
  }
});

test("the declarations say which options each runtime refuses", () => {
  const refused = Object.fromEntries(runtimes.list().map((runtime) => [runtime.id, Object.keys(runtime.refusedSessionOptions ?? {}).toSorted()]));
  assert.deepEqual(refused, {
    antigravity: ["appendSystemPrompt", "systemPrompt"],
    claude: [],
    codex: [],
    cursor: ["appendSystemPrompt", "env", "systemPrompt"],
    grok: [],
    kimi: ["appendSystemPrompt", "systemPrompt"],
    pi: [],
  });
});

test("a runtime that refuses env cannot be a subagent, and spawn says why before opening", async () => {
  const base = scriptedRuntime({ id: "inproc", turn: () => assert.fail("never opened") });
  const inproc = defineRuntime({ ...base, refusedSessionOptions: { env: "no environment here" } });
  const crew = createSubagents({ runtimes: { get: (id) => (id === "inproc" ? inproc : undefined) } });
  expect(await crew.spawn({ runtime: "inproc", task: "t" })).toEqual({
    kind: "refused",
    code: "open_failed",
    reason: "inproc cannot be a subagent: no environment here",
  });
  await crew.close();
});
