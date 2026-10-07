import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import type { AvailableInstallation } from "../packages/oar/src/contracts/installation.js";
import type { RefusableSessionOption } from "../packages/oar/src/contracts/runtime.js";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { defineRuntime, UnsupportedOptionError } from "../packages/oar/src/index.js";
import { refuseSessionOptions } from "../packages/oar/src/shared/session-options.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const given: Readonly<Record<RefusableSessionOption, Partial<SessionOptions>>> = {
  systemPrompt: { systemPrompt: "x" },
  appendSystemPrompt: { appendSystemPrompt: "x" },
  env: { env: { OAR_PROBE: "1" } },
  mcpServers: { mcpServers: [{ name: "probe", command: "/nonexistent/oar-probe" }] },
};

// Declared refusals are checked before anything starts, so an installation
// that points nowhere is enough: the open must reject with an
// UnsupportedOptionError naming the option, the declared reason its message.
function nowhere(id: string): AvailableInstallation {
  return id === "pi" || id === "cursor" ? { kind: "available", via: "bundled" } : { kind: "available", via: "executable", command: "/nonexistent/oar-probe" };
}

test("every declared refusal is what session() rejects with", async () => {
  const declaring = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions !== undefined);
  assert.deepEqual(declaring.map((runtime) => runtime.id).toSorted(), ["antigravity", "cursor", "kimi"]);
  for (const runtime of declaring) {
    const keys = (["systemPrompt", "appendSystemPrompt", "env", "mcpServers"] as const).filter((key) => runtime.refusedSessionOptions?.[key] !== undefined);
    for (const key of keys) {
      const opening = runtime.session(nowhere(runtime.id), { cwd: "/tmp", ...given[key] });
      // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
      await expect(opening, `${runtime.id} ${key}`).rejects.toBeInstanceOf(UnsupportedOptionError);
      // oxlint-disable-next-line no-await-in-loop -- the same settled open, read again.
      await expect(opening, `${runtime.id} ${key}`).rejects.toMatchObject({ name: "UnsupportedOptionError", option: key, message: runtime.refusedSessionOptions?.[key] });
    }
  }
});

test("the declarations say which options each runtime refuses", () => {
  const refused = Object.fromEntries(allRuntimes.list().map((runtime) => [runtime.id, Object.keys(runtime.refusedSessionOptions ?? {}).toSorted()]));
  assert.deepEqual(refused, {
    antigravity: ["appendSystemPrompt", "systemPrompt"],
    claude: [],
    codex: [],
    cursor: ["appendSystemPrompt", "env", "mcpServers", "systemPrompt"],
    grok: [],
    kimi: ["appendSystemPrompt", "systemPrompt"],
    opencode: [],
    pi: [],
  });
});

test("an empty mcpServers list is no MCP server given, so no runtime refuses it", () => {
  for (const runtime of allRuntimes.list()) {
    assert.doesNotThrow(() => {
      refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", mcpServers: [] });
    }, runtime.id);
  }
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
