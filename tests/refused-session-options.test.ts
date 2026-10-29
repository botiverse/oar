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
  goals: { goals: true },
  userConfiguration: { userConfiguration: "exclude" },
  additionalDirectories: { additionalDirectories: ["/extra"] },
  outputSchema: { outputSchema: {} },
  serviceTier: { serviceTier: "fast" },
  disallowedTools: { disallowedTools: ["native_tool"] },
  systemPrompt: { systemPrompt: "x" },
  appendSystemPrompt: { appendSystemPrompt: "x" },
  env: { env: { OAR_PROBE: "1" } },
  mcpServers: { mcpServers: [{ name: "probe", command: "/nonexistent/oar-probe" }] },
  mcpServerCredentials: { mcpServers: [{ name: "served", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer probe" } }] },
  launchArgs: { launchArgs: ["--probe"] },
  name: { name: "probe" },
};

// Declared refusals are checked before anything starts, so an installation
// that points nowhere is enough: the open must reject with an
// UnsupportedOptionError naming the option, the declared reason its message.
function nowhere(id: string): AvailableInstallation {
  return id === "pi" || id === "cursor" ? { kind: "available", via: "bundled" } : { kind: "available", via: "executable", command: "/nonexistent/oar-probe" };
}

// The declared reason, followed by the refused values where the error names them.
function refusalMessage(reason: string | undefined, key: RefusableSessionOption): string | undefined {
  if (key === "disallowedTools") {
    return `${String(reason)}: ${JSON.stringify(given[key].disallowedTools)}`;
  }
  return key === "mcpServerCredentials" ? `${String(reason)}: ["served"]` : reason;
}

test("every declared refusal is what session() rejects with", async () => {
  const declaring = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions !== undefined);
  assert.deepEqual(declaring.map((runtime) => runtime.id).toSorted(), ["antigravity", "claude", "codebuddy", "codex", "cursor", "grok", "kimi", "opencode", "pi", "qoder", "qwen"]);
  for (const runtime of declaring) {
    const keys = (["systemPrompt", "appendSystemPrompt", "env", "mcpServers", "mcpServerCredentials", "disallowedTools", "launchArgs", "serviceTier", "additionalDirectories", "outputSchema", "name", "userConfiguration", "goals"] as const).filter((key) => runtime.refusedSessionOptions?.[key] !== undefined);
    for (const key of keys) {
      const opening = runtime.session(nowhere(runtime.id), { cwd: "/tmp", ...given[key] });
      // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
      await expect(opening, `${runtime.id} ${key}`).rejects.toBeInstanceOf(UnsupportedOptionError);
      // oxlint-disable-next-line no-await-in-loop -- the same settled open, read again.
      await expect(opening, `${runtime.id} ${key}`).rejects.toMatchObject({ name: "UnsupportedOptionError", option: key === "mcpServerCredentials" ? "mcpServers" : key, message: refusalMessage(runtime.refusedSessionOptions?.[key], key) });
    }
  }
});

test("the declarations say which options each runtime refuses", () => {
  const refused = Object.fromEntries(allRuntimes.list().map((runtime) => [runtime.id, Object.keys(runtime.refusedSessionOptions ?? {}).toSorted()]));
  assert.deepEqual(refused, {
    antigravity: ["additionalDirectories", "goals", "mcpServerCredentials", "name", "outputSchema", "serviceTier", "systemPrompt", "userConfiguration"],
    claude: ["goals"],
    codebuddy: ["additionalDirectories", "appendSystemPrompt", "goals", "name", "outputSchema", "serviceTier", "userConfiguration"],
    codex: ["userConfiguration"],
    cursor: ["appendSystemPrompt", "env", "goals", "launchArgs", "mcpServers", "name", "outputSchema", "serviceTier", "systemPrompt"],
    grok: ["additionalDirectories", "disallowedTools", "goals", "name", "serviceTier", "userConfiguration"],
    kimi: ["appendSystemPrompt", "disallowedTools", "goals", "name", "outputSchema", "serviceTier", "systemPrompt", "userConfiguration"],
    opencode: ["disallowedTools", "goals", "name", "outputSchema", "serviceTier", "userConfiguration"],
    pi: ["additionalDirectories", "goals", "launchArgs", "outputSchema", "serviceTier", "userConfiguration"],
    qoder: ["goals", "name", "outputSchema", "serviceTier", "userConfiguration"],
    qwen: ["goals", "name", "outputSchema", "serviceTier", "userConfiguration"],
  });
});

// claude and pi would open unnamed without a word, codex would refuse it only after the thread opened.
test.each(["", "   ", "a\0b"])("a blank name or one with a NUL is refused before anything starts on the runtimes that take one: %j", async (name) => {
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.name === undefined)) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", name }), runtime.id).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "name", message: "name must not be blank or contain NUL characters" });
  }
  expect(allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.name === undefined).map((runtime) => runtime.id).toSorted()).toEqual(["claude", "codex", "pi"]);
});

test("omitted or false goals preserves native defaults on every declared runtime", () => {
  for (const runtime of allRuntimes.list()) {
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp" }); }).not.toThrow();
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", goals: false }); }).not.toThrow();
  }
});

test("an empty mcpServers list is no MCP server given, so no runtime refuses it", () => {
  for (const runtime of allRuntimes.list()) {
    assert.doesNotThrow(() => {
      refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", mcpServers: [] });
    }, runtime.id);
  }
});

// serveMcpTools always hands an http entry with an Authorization header, so a
// host reads from the declarations alone whether its served tools attach.
test("entries without credentials are no mcpServerCredentials given, and every runtime that refuses them declares so", () => {
  const bare = [{ name: "local", command: "/bin/echo", env: {} }, { name: "remote", type: "http" as const, url: "http://127.0.0.1:9/mcp" }];
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.mcpServers === undefined)) {
    assert.doesNotThrow(() => {
      refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", mcpServers: bare });
    }, runtime.id);
  }
  const refusing = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.mcpServers !== undefined || runtime.refusedSessionOptions?.mcpServerCredentials !== undefined);
  expect(refusing.map((runtime) => runtime.id).toSorted()).toEqual(["antigravity", "cursor"]);
});

// Some runtimes drop a server so named without a word (#395): every runtime
// that takes mcpServers refuses the names before anything starts.
test.each(["__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"])("a reserved MCP server name is refused before anything starts: %s", async (name) => {
  const taking = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.mcpServers === undefined);
  expect(taking.map((runtime) => runtime.id).toSorted()).toEqual(["antigravity", "claude", "codebuddy", "codex", "grok", "kimi", "opencode", "pi", "qoder", "qwen"]);
  for (const runtime of taking) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", mcpServers: [{ name, command: "/nonexistent/oar-probe" }] }), runtime.id).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers", message: `mcpServers name ${JSON.stringify(name)} is reserved: some runtimes drop a server so named without a word` });
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


test("empty disallowedTools is no restriction, including on refused runtimes", () => {
  for (const runtime of allRuntimes.list()) {
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", disallowedTools: [] }); }).not.toThrow();
  }
});

test("unsupported tool denial refuses before resume lookup and prompt preparation", async () => {
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.disallowedTools !== undefined)) {
    // oxlint-disable-next-line no-await-in-loop -- Each refused runtime must fail before opening.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/nonexistent", resume: "old", disallowedTools: ["mcp__server__tool"], ...(runtime.id === "opencode" ? { systemPrompt: "replace" } : {}) })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  }
});

test("empty additionalDirectories is no override even on refused runtimes", () => {
  for (const runtime of allRuntimes.list()) {
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", additionalDirectories: [] }); }).not.toThrow();
  }
});

test("explicit include and omission preserve existing runtime behavior", () => {
  for (const runtime of allRuntimes.list()) {
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", userConfiguration: "include" }); }).not.toThrow();
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp" }); }).not.toThrow();
  }
});
