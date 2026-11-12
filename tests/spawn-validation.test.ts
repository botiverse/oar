/* oxlint-disable import/max-dependencies -- Exercises each shared process entry with the same native validation failure. */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { spawnNodeScript } from "../packages/oar/src/shared/executable/node-script.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { readExecutableVersion } from "../packages/oar/src/shared/executable/version.js";
import { runIsolated } from "../packages/oar/src/shared/executable/isolated.js";
import { processTableCommand } from "../packages/oar/src/shared/executable/process-table-command.js";
import { spawnLoginProcess } from "../packages/oar/src/shared/login.js";
import { createAcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";

const secret = "synthetic-spawn-secret-314159265";
const env = { OAR_TEST_SECRET: `${secret}\0` };

function noValue(value: unknown): void {
  expect(inspect(value, { depth: 20, showHidden: true })).not.toContain(secret);
  expect(JSON.stringify(value)).not.toContain(secret);
}

const starts: Record<string, () => unknown> = {
  nodeScript: () => spawnNodeScript("process.exit(0)", "", env),
  login: () => spawnLoginProcess(process.execPath, [], env, { onLine() {} }),
  watchedLogin: () => spawnLoginProcess(process.execPath, [], env, { onLine() {} }, { stopWithHost: true }),
  isolated: async () => runIsolated(process.execPath, [], { env, timeoutMs: 1000 }),
  processTable: async () => processTableCommand(process.execPath, [], env),
  terminal: async () => createAcpTerminalHost(process.cwd(), env).create({ sessionId: "test", command: process.execPath }),
};

test.each(Object.entries(starts))("%s refuses invalid env without exposing Node's escaped value", async (_name, start) => {
  const failure: unknown = await Promise.resolve().then(start).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  noValue(failure);
  expect(failure).toHaveProperty("code", "ERR_INVALID_ARG_VALUE");
  expect(failure.message).toContain("without null bytes");
  expect(failure.cause).toBeUndefined();
});

test("version probes keep native validation diagnostics without the rejected env value", async () => {
  const failure: unknown = await readExecutableVersion(process.execPath, 1000, undefined, env).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  noValue(failure);
  expect(failure.message).toContain("ERR_INVALID_ARG_VALUE");
  expect(failure.cause).toMatchObject({ error: { code: "ERR_INVALID_ARG_VALUE" }, exitCode: null });
});

test("one-shot results omit an invalid argument's value too", async () => {
  const result = await runExecutable(process.execPath, ["-e", `${secret}\0`]);
  noValue(result);
  expect(result).toMatchObject({ ok: false, exitCode: null, diagnostics: { error: { code: "ERR_INVALID_ARG_VALUE" } } });
});

test.each(["argument", "restored environment"])("the watchdog does not echo invalid %s decoded from its launch spec", async (source) => {
  let output = "";
  const args = source === "argument" ? ["-e", `${secret}\0`] : ["--version"];
  const environment = source === "argument" ? {} : { ELECTRON_RUN_AS_NODE: `${secret}\0` };
  const child = spawnLoginProcess(process.execPath, args, environment, {
    onLine: (text) => { output += `${text}\n`; },
  }, { stopWithHost: true });
  try {
    expect(await child.exited).toMatchObject({ exitCode: 1 });
    noValue(output);
    expect(output).toBe("oar watchdog: command spawn failed\n");
  } finally { child.stop(); }
});
