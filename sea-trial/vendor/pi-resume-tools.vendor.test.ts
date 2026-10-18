import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { piInstallation, piSession, UnsupportedOptionError, type SessionOptions } from "../../packages/oar/src/index.js";
import { openPiAgentSession } from "../../packages/oar/src/runtimes/pi/open.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock } from "../harness/aimock.js";

const inactiveTools = [
  { kind: "default-inactive", flags: { defaultActive: false } },
  { kind: "deferred", flags: { exposure: "deferred" } },
  { kind: "codemode", flags: { exposure: "codemode" } },
] as const;
const builtins = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

function register(name: string, flags: Readonly<Record<string, unknown>>): string {
  return `pi.registerTool({ name: ${JSON.stringify(name)}, label: "probe", description: "probe",
    parameters: { type: "object", properties: {} }, ...${JSON.stringify(flags)},
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });`;
}

async function fixture(extension: string, emptyDefaults: boolean) {
  const env = await startPiAimock((mock) => { mock.onMessage(/TOOL_LOADOUT_OK/u, { content: "TOOL_LOADOUT_OK" }); },
    { captureRaw: true, settings: emptyDefaults ? { defaultTools: [] } : {} });
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined && agentDir.length > 0, "startPiAimock must select an isolated agent directory");
  const cwd = path.join(agentDir, "project");
  await mkdir(cwd);
  await mkdir(path.join(agentDir, "extensions"));
  await writeFile(path.join(agentDir, "extensions", "resume-tools.ts"), `export default (pi) => { ${extension} };`);
  const sessions: AgentSession[] = [];
  return {
    async open(options: Partial<SessionOptions> = {}) {
      const session = await openPiAgentSession({ cwd, model: "aimock/aimock-model", ...options });
      sessions.push(session);
      return session;
    },
    async savedTools(names: readonly string[], removed: readonly string[] = []) {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const saved = SessionManager.create(cwd, piSessionDir(cwd, agentDir));
      saved.appendMessage({ role: "user", content: [{ type: "text", text: "previous turn" }], timestamp: Date.now() });
      saved.appendMessage({
        role: "system", content: "", timestamp: Date.now(),
        toolsAdded: names.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })),
      });
      if (removed.length > 0) {
        saved.appendMessage({ role: "system", content: "", timestamp: Date.now(), toolsRemoved: removed.map((name) => ({ name })) });
      }
      return saved.getSessionId();
    },
    cwd,
    raw: env.raw,
    async stop() {
      try {
        for (const session of sessions) { session.dispose(); }
      } finally { await env.stop(); }
    },
  };
}

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi resumed tool selection before the first prompt", () => {
  const cases = inactiveTools.flatMap(({ kind, flags }) => ["load", "session_start"].flatMap((when) =>
    [false, true].map((emptyDefaults) => ({ kind, flags, when, emptyDefaults }))));

  test.each(cases)("$kind registered at $when, empty defaults=$emptyDefaults", async ({ kind, flags, when, emptyDefaults }) => {
    const registration = register("inactive_probe", flags);
    const setup = await fixture(when === "load" ? registration : `pi.on("session_start", () => { ${registration} });`, emptyDefaults);
    try {
      const fresh = await setup.open();
      const resume = await setup.savedTools(emptyDefaults ? ["inactive_probe"] : ["read", "inactive_probe"]);
      const resumed = await setup.open({ resume });
      // openPiAgentSession has awaited session_start. Check open state here;
      // the provider-request regression below also covers the first turn.
      expect(fresh.getAllTools().map((tool) => tool.name)).toContain("inactive_probe");
      expect(resumed.getAllTools().map((tool) => tool.name)).toContain("inactive_probe");
      const expected = emptyDefaults ? [] : ["bash", "edit", "read", "write"];
      // Deferred/codemode tools remain callable through native tool-to-tool
      // execution even when they are absent from the active declarations.
      const callable = [...expected, ...(kind === "default-inactive" ? [] : ["inactive_probe"])].toSorted();
      expect(fresh.getCallableToolNames().toSorted()).toEqual(callable);
      expect(resumed.getCallableToolNames().toSorted()).toEqual(callable);
      expect(fresh.getActiveToolNames().toSorted()).toEqual(expected);
      expect(resumed.getActiveToolNames().toSorted()).toEqual(expected);
      expect(setup.raw).toEqual([]);
    } finally { await setup.stop(); }
  });

  test.each(["deferred", "codemode"])("a %s-only initial registry can clear pending names with an empty loadout", async (exposure) => {
    const setup = await fixture(`${register("resident", { exposure })}
      pi.on("session_start", () => { ${register("late_probe", { defaultActive: false })} });`, true);
    try {
      const options = { disallowedTools: builtins };
      const fresh = await setup.open(options);
      const resume = await setup.savedTools(["late_probe"]);
      const resumed = await setup.open({ ...options, resume });
      expect(fresh.getAllTools().map((tool) => tool.name).toSorted()).toEqual(["late_probe", "resident"]);
      expect(resumed.getAllTools().map((tool) => tool.name).toSorted()).toEqual(["late_probe", "resident"]);
      expect(fresh.getActiveToolNames()).toEqual([]);
      expect(resumed.getActiveToolNames()).toEqual([]);
      expect(fresh.getCallableToolNames()).toEqual(["resident"]);
      expect(resumed.getCallableToolNames()).toEqual(["resident"]);
    } finally { await setup.stop(); }
  });

  test.each([false, true])("no activatable registered tools rejects resume before binding and disposes the session; hidden tool=%s", async (hidden) => {
    const setup = await fixture(`${hidden ? register("hidden_probe", { exposure: "hidden" }) : ""}
      pi.on("session_start", () => { ${register("late_probe", { defaultActive: false })} });`, true);
    const { AgentSession } = await import("@earendil-works/pi-coding-agent");
    try {
      const fresh = await setup.open({ disallowedTools: builtins });
      expect(fresh.getActiveToolNames()).toEqual([]);
      const resume = await setup.savedTools(["late_probe"]);
      const installation = await piInstallation();
      assert.ok(installation.kind === "available", `pi installation: ${installation.kind}`);
      const dispose = vi.spyOn(AgentSession.prototype, "dispose");
      const bind = vi.spyOn(AgentSession.prototype, "bindExtensions");
      const opening = piSession(installation, { cwd: setup.cwd, model: "aimock/aimock-model", resume, disallowedTools: builtins });
      try {
        await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
        await expect(opening).rejects.toMatchObject({
          option: "resume",
          message: "pi cannot reset restored pending tools on resume: transcript has unregistered tool names but no registered tool can be activated to clear them; open a new session instead",
        });
        expect(bind).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        dispose.mockRestore();
        bind.mockRestore();
        const [result] = await Promise.allSettled([opening]);
        if (result.status === "fulfilled") { await result.value.dispose(); }
      }
    } finally { await setup.stop(); }
  });

  test("a tool-free conversation can resume after its first turn", async () => {
    const setup = await fixture("", false);
    try {
      const options = { disallowedTools: builtins };
      const fresh = await setup.open(options);
      expect(fresh.getAllTools()).toEqual([]);
      expect(fresh.getActiveToolNames()).toEqual([]);
      await fresh.prompt("Reply with TOOL_LOADOUT_OK.");
      expect(setup.raw).toHaveLength(1);
      fresh.dispose();
      const resumed = await setup.open({ ...options, resume: fresh.sessionId });
      expect(resumed.getAllTools()).toEqual([]);
      expect(resumed.getActiveToolNames()).toEqual([]);
      expect(resumed.getCallableToolNames()).toEqual([]);
    } finally { await setup.stop(); }
  });

  test("only explicitly excluded transcript tools do not block a tool-free resume", async () => {
    const setup = await fixture("", false);
    try {
      const resume = await setup.savedTools(["bash"]);
      const resumed = await setup.open({ resume, disallowedTools: builtins });
      expect(resumed.getAllTools()).toEqual([]);
      expect(resumed.getActiveToolNames()).toEqual([]);
      expect(resumed.getCallableToolNames()).toEqual([]);
    } finally { await setup.stop(); }
  });

  test("a removed transcript tool does not become pending during a tool-free resume", async () => {
    const setup = await fixture(`pi.on("session_start", () => { ${register("late_probe", { defaultActive: false })} });`, true);
    try {
      const resume = await setup.savedTools(["late_probe"], ["late_probe"]);
      const resumed = await setup.open({ resume, disallowedTools: builtins });
      expect(resumed.getAllTools().map((tool) => tool.name)).toEqual(["late_probe"]);
      expect(resumed.getActiveToolNames()).toEqual([]);
      expect(resumed.getCallableToolNames()).toEqual([]);
    } finally { await setup.stop(); }
  });

  test("session_start may deliberately activate a default-inactive tool", async () => {
    const setup = await fixture(`pi.on("session_start", () => {
      ${register("chosen_probe", { defaultActive: false })}
      pi.setActiveTools(["chosen_probe"]);
    });`, false);
    try {
      const fresh = await setup.open();
      const resume = await setup.savedTools(["chosen_probe"]);
      const resumed = await setup.open({ resume });
      expect(fresh.getActiveToolNames()).toEqual(["chosen_probe"]);
      expect(resumed.getActiveToolNames()).toEqual(["chosen_probe"]);
    } finally { await setup.stop(); }
  });

  test("the first provider request excludes the late default-inactive tool on both fresh and resumed opens", async () => {
    const setup = await fixture(`pi.on("session_start", () => { ${register("late_probe", { defaultActive: false })} });`, false);
    try {
      const fresh = await setup.open();
      const resume = await setup.savedTools(["read", "late_probe"]);
      const resumed = await setup.open({ resume });
      for (const session of [fresh, resumed]) {
        const offset = setup.raw.length;
        await session.prompt("Reply with TOOL_LOADOUT_OK.");
        const requests = setup.raw.slice(offset);
        expect(requests).toHaveLength(1);
        const tools = asRecord(requests[0]?.body)?.tools;
        assert.ok(Array.isArray(tools), "the provider request must declare its tools");
        const names = tools.map((tool) => {
          const name = asRecord(tool)?.name;
          assert.ok(typeof name === "string", "a provider tool must have a name");
          return name;
        });
        expect(names.toSorted()).toEqual(["bash", "edit", "read", "write"]);
      }
    } finally { await setup.stop(); }
  });
});
