import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import type { AvailableInstallation } from "../packages/oar/src/contracts/installation.js";
import type { RefusableSessionOption } from "../packages/oar/src/contracts/runtime.js";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { createPiRuntime, defineRuntime, UnsupportedOptionError } from "../packages/oar/src/index.js";
import { refuseSessionOptions } from "../packages/oar/src/shared/session-options.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const refusalNames: Partial<Record<RefusableSessionOption, keyof SessionOptions>> = { partialUserConfiguration: "userConfiguration", mcpServerCredentials: "mcpServers" };

const given: Readonly<Record<RefusableSessionOption, Partial<SessionOptions>>> = {
  ephemeral: { ephemeral: true },
  goals: { goals: true },
  endTurnProcessesOnAbort: { endTurnProcessesOnAbort: true },
  userConfiguration: { userConfiguration: "exclude" },
  partialUserConfiguration: { userConfiguration: { exclude: ["settings"] } },
  additionalDirectories: { additionalDirectories: ["/extra"] },
  outputSchema: { outputSchema: {} },
  serviceTier: { serviceTier: "fast" },
  serviceTierFallback: { serviceTier: "fast", serviceTierFallback: "default" },
  disallowedTools: { disallowedTools: ["native_tool"] },
  systemPrompt: { systemPrompt: "x" },
  appendSystemPrompt: { appendSystemPrompt: "x" },
  env: { env: { OAR_PROBE: "1" } },
  mcpServers: { mcpServers: [{ name: "probe", command: "/nonexistent/oar-probe" }] },
  mcpServerCredentials: { mcpServers: [{ name: "served", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer probe" } }] },
  launchArgs: { launchArgs: ["--probe"] },
  name: { name: "probe" },
  fork: { fork: { through: "anchor" }, resume: "source" },
  nativeMemoryDefault: { nativeMemoryDefault: "off" },
  sessionLogUpload: { sessionLogUpload: "off" },
  nativePermissions: { nativePermissions: "inherit" },
  userQuestions: { userQuestions: "host" },
  modelRequests: { modelRequests: "latest" },
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
  assert.deepEqual(declaring.map((runtime) => runtime.id).toSorted(), ["antigravity", "claude", "codebuddy", "codex", "cursor", "devin", "dsh", "factory", "grok", "kimi", "opencode", "pi", "qoder", "qwen"]);
  for (const runtime of declaring) {
    const keys = (["systemPrompt", "appendSystemPrompt", "env", "mcpServers", "mcpServerCredentials", "disallowedTools", "launchArgs", "serviceTier", "serviceTierFallback", "additionalDirectories", "outputSchema", "name", "userConfiguration", "partialUserConfiguration", "ephemeral", "goals", "endTurnProcessesOnAbort", "fork", "nativeMemoryDefault", "sessionLogUpload", "nativePermissions", "userQuestions"] as const).filter((key) => runtime.refusedSessionOptions?.[key] !== undefined);
    for (const key of keys) {
      const option = refusalNames[key] ?? key;
      const opening = runtime.session(nowhere(runtime.id), { cwd: "/tmp", ...given[key] });
      // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
      await expect(opening, `${runtime.id} ${key}`).rejects.toBeInstanceOf(UnsupportedOptionError);
      // oxlint-disable-next-line no-await-in-loop -- the same settled open, read again.
      await expect(opening, `${runtime.id} ${key}`).rejects.toMatchObject({ name: "UnsupportedOptionError", option, message: refusalMessage(runtime.refusedSessionOptions?.[key], key) });
    }
  }
});

test("the declarations say which options each runtime refuses", () => {
  const refused = Object.fromEntries(allRuntimes.list().map((runtime) => [runtime.id, Object.keys(runtime.refusedSessionOptions ?? {}).toSorted()]));
  assert.deepEqual(refused, {
    antigravity: ["additionalDirectories", "disallowedTools", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "mcpServerCredentials", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "systemPrompt", "userConfiguration", "userQuestions"],
    claude: ["endTurnProcessesOnAbort", "ephemeral", "goals", "nativeMemoryDefault", "nativePermissions", "sessionLogUpload"],
    codebuddy: ["additionalDirectories", "appendSystemPrompt", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    codex: ["modelRequests", "nativeMemoryDefault", "sessionLogUpload", "userConfiguration"],
    cursor: ["appendSystemPrompt", "endTurnProcessesOnAbort", "env", "ephemeral", "fork", "goals", "launchArgs", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "partialUserConfiguration", "serviceTierFallback", "sessionLogUpload", "systemPrompt", "userQuestions"],
    devin: ["additionalDirectories", "appendSystemPrompt", "disallowedTools", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "mcpServerCredentials", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "systemPrompt", "userConfiguration", "userQuestions"],
    dsh: ["endTurnProcessesOnAbort", "ephemeral", "fork", "launchArgs", "modelRequests", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "userConfiguration", "userQuestions"],
    factory: ["additionalDirectories", "disallowedTools", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    grok: ["additionalDirectories", "disallowedTools", "ephemeral", "fork", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    kimi: ["disallowedTools", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "systemPrompt", "userConfiguration", "userQuestions"],
    opencode: ["disallowedTools", "endTurnProcessesOnAbort", "ephemeral", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    pi: ["additionalDirectories", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "launchArgs", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    qoder: ["endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "modelRequests", "name", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
    qwen: ["endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "modelRequests", "name", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions"],
  });
});

// claude and pi would open unnamed without a word, codex would refuse it only after the thread opened.
test.each(["", "   ", "a\0b"])("a blank name or one with a NUL is refused before anything starts on the runtimes that take one: %j", async (name) => {
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.name === undefined)) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", name }), runtime.id).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "name", message: "name must not be blank or contain NUL characters" });
  }
  expect(allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.name === undefined).map((runtime) => runtime.id).toSorted()).toEqual(["claude", "codex", "dsh", "pi"]);
});

test("omitted or false ephemeral, goals and endTurnProcessesOnAbort preserve native defaults on every declared runtime", () => {
  for (const runtime of allRuntimes.list()) {
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp" }); }).not.toThrow();
    expect(() => { refuseSessionOptions(runtime.refusedSessionOptions ?? {}, { cwd: "/tmp", ephemeral: false, goals: false, endTurnProcessesOnAbort: false }); }).not.toThrow();
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
  expect(refusing.map((runtime) => runtime.id).toSorted()).toEqual(["antigravity", "devin"]);
});

// Some runtimes drop a server so named without a word (#395): every runtime
// that takes mcpServers refuses the names before anything starts.
test.each(["__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"])("a reserved MCP server name is refused before anything starts: %s", async (name) => {
  const taking = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.mcpServers === undefined);
  expect(taking.map((runtime) => runtime.id).toSorted()).toEqual(["antigravity", "claude", "codebuddy", "codex", "cursor", "devin", "dsh", "factory", "grok", "kimi", "opencode", "pi", "qoder", "qwen"]);
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

test("empty user configuration exclusions and explicit include keep the native configuration", () => {
  for (const runtime of allRuntimes.list()) {
    const refused = runtime.refusedSessionOptions ?? {};
    expect(() => { refuseSessionOptions(refused, { cwd: "/tmp" }); }).not.toThrow();
    for (const userConfiguration of ["include", { exclude: [] }] as const) {
      expect(() => { refuseSessionOptions(refused, { cwd: "/tmp", userConfiguration }); }).not.toThrow();
    }
  }
});

test("declared user configuration refusals apply to category lists", () => {
  for (const runtime of allRuntimes.list()) {
    const refused = runtime.refusedSessionOptions ?? {};
    if (refused.userConfiguration !== undefined || refused.partialUserConfiguration !== undefined) {
      for (const exclude of [["settings"], ["mcp", "instructions"], ["settings", "settings"]] as const) {
        expect(() => { refuseSessionOptions(refused, { cwd: "/tmp", userConfiguration: { exclude } }); }).toThrow(UnsupportedOptionError);
      }
    }
    if (refused.userConfiguration !== undefined) {
      expect(() => { refuseSessionOptions(refused, { cwd: "/tmp", userConfiguration: { exclude: ["instructions", "mcp", "settings"] } }); }).toThrow(UnsupportedOptionError);
    }
  }
});

test("claude, codex and opencode can take fork, and they refuse one without resume or with a blank anchor before anything starts", async () => {
  const taking = allRuntimes.list().filter((runtime) => runtime.refusedSessionOptions?.fork === undefined);
  expect(taking.map((runtime) => runtime.id).toSorted()).toEqual(["claude", "codex", "opencode"]);
  for (const runtime of taking) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", fork: {} }), runtime.id).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "fork", message: "fork copies the saved session resume names; give resume with the source session id" });
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", resume: "source", fork: { through: "" } }), runtime.id).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "fork", message: "fork.through must not be blank or contain NUL characters" });
  }
  expect(() => { refuseSessionOptions({}, { cwd: "/tmp", resume: "source", fork: {} }); }).not.toThrow();
  expect(() => { refuseSessionOptions({}, { cwd: "/tmp", resume: "source", fork: { through: "-anchor" } }); }).not.toThrow();
});

test("the scripted runtime declares and refuses fork: a script keeps no conversation to copy", async () => {
  const runtime = scriptedRuntime({ turn: () => assert.fail("never opened") });
  expect(runtime.refusedSessionOptions).toEqual({ fork: "a scripted runtime keeps no saved conversation to fork", modelRequests: "The scripted runtime sends no provider request", userQuestions: "The scripted runtime asks no questions" });
  await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: "/tmp", resume: "source", fork: {} })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "fork", message: "a scripted runtime keeps no saved conversation to fork" });
});

test.each(["", "   ", "-c", "--continue", "--help", "id\0secret"])("an empty, dash-leading or NUL-containing resume is refused before anything starts on every runtime: %j", async (resume) => {
  const secret = "sk-secret-resume-canary-99887766";
  const value = resume === "id\0secret" ? `id\0${secret}` : resume;
  for (const runtime of allRuntimes.list()) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    const failure: unknown = await runtime.session(nowhere(runtime.id), {
      cwd: "/tmp",
      resume: value,
      ...(runtime.id === "opencode" ? { systemPrompt: "replace" } : {}),
    }).catch((error: unknown) => error);
    expect(failure, runtime.id).toBeInstanceOf(UnsupportedOptionError);
    expect(failure, runtime.id).toMatchObject({
      name: "UnsupportedOptionError",
      option: "resume",
      message: "resume must be a non-empty session id not starting with - and without NUL characters",
    });
    expect(JSON.stringify(failure), runtime.id).not.toContain(secret);
  }
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.fork === undefined)) {
    // oxlint-disable-next-line no-await-in-loop -- also check fork with invalid source resume on fork-supporting runtimes.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", resume: value, fork: {} }), `${runtime.id} fork`).rejects.toMatchObject({
      name: "UnsupportedOptionError",
      option: "resume",
    });
  }
});

test("subprocess Pi accepts credentialed mcpServers and declares only its non-credential refusals", async () => {
  const rpc = createPiRuntime({ execution: "subprocess" });
  expect(Object.keys(rpc.refusedSessionOptions ?? {}).toSorted()).toEqual([
    "additionalDirectories", "endTurnProcessesOnAbort", "ephemeral", "fork", "goals", "launchArgs",
    "modelRequests", "nativeMemoryDefault", "nativePermissions", "outputSchema", "serviceTier", "sessionLogUpload", "userConfiguration", "userQuestions",
  ]);
  expect(() => {
    refuseSessionOptions(rpc.refusedSessionOptions ?? {}, { cwd: "/tmp", ...given.mcpServerCredentials });
  }).not.toThrow();
  await expect(rpc.session(nowhere("pi"), { cwd: "/tmp", launchArgs: ["--probe"] }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "launchArgs" });
});

test("unexpected nativePermissions values are rejected before opening", () => {
  expect(() => {
    // @ts-expect-error -- Verify runtime validation rejects values outside the union.
    refuseSessionOptions({}, { cwd: "/tmp", nativePermissions: "bypass" });
  }).toThrow(UnsupportedOptionError);
  expect(() => {
    // @ts-expect-error -- Verify runtime validation rejects empty strings.
    refuseSessionOptions({}, { cwd: "/tmp", nativePermissions: "" });
  }).toThrow(UnsupportedOptionError);
  expect(() => {
    refuseSessionOptions({}, { cwd: "/tmp", nativePermissions: "inherit" });
  }).not.toThrow();
});

test("unexpected userQuestions values are rejected before opening", () => {
  expect(() => {
    // @ts-expect-error -- Verify runtime validation rejects values outside the union.
    refuseSessionOptions({}, { cwd: "/tmp", userQuestions: "auto" });
  }).toThrow(UnsupportedOptionError);
  expect(() => { refuseSessionOptions({}, { cwd: "/tmp", userQuestions: "host" }); }).not.toThrow();
});

test("serviceTierFallback requires serviceTier and rejects values outside the union before opening", async () => {
  expect(() => {
    // @ts-expect-error -- Verify runtime validation rejects values outside the union.
    refuseSessionOptions({}, { cwd: "/tmp", serviceTier: "priority", serviceTierFallback: "flex" });
  }).toThrow(UnsupportedOptionError);
  expect(() => {
    // @ts-expect-error -- Verify runtime validation rejects empty strings.
    refuseSessionOptions({}, { cwd: "/tmp", serviceTier: "priority", serviceTierFallback: "" });
  }).toThrow(UnsupportedOptionError);
  expect(() => {
    refuseSessionOptions({}, { cwd: "/tmp", serviceTierFallback: "default" });
  }).toThrow(UnsupportedOptionError);
  expect(() => {
    refuseSessionOptions({}, { cwd: "/tmp", serviceTier: "priority", serviceTierFallback: "default" });
  }).not.toThrow();
  for (const runtime of allRuntimes.list()) {
    // oxlint-disable-next-line no-await-in-loop -- One open at a time keeps the refusal attributable.
    await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", serviceTierFallback: "default" }), runtime.id)
      .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "serviceTierFallback" });
    if (runtime.refusedSessionOptions?.serviceTier !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- Non-tier runtimes refuse serviceTier first.
      await expect(runtime.session(nowhere(runtime.id), { cwd: "/tmp", serviceTier: "priority", serviceTierFallback: "default" }), runtime.id)
        .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "serviceTier" });
    }
  }
});
