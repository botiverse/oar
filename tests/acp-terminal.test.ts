import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  createAcpTerminalHost,
  type AcpTerminalHost,
  type AcpTerminalHostOptions,
} from "../packages/oar/src/shared/acp/terminal.js";

const hosts: AcpTerminalHost[] = [];

function host(options: AcpTerminalHostOptions = {}): AcpTerminalHost {
  const value = createAcpTerminalHost(process.cwd(), process.env, options);
  hosts.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (value) => {
    await value.dispose();
  }));
});

test("ACP terminal runs with cwd/env and truncates UTF-8 output at a character boundary", async () => {
  const terminal = host();
  const created = await terminal.request("terminal/create", {
    sessionId: "session-one",
    command: process.execPath,
    args: ["-e", "process.stdout.write((process.env.OAR_TERMINAL_VALUE ?? '') + ':αβγ')"],
    env: [{ name: "OAR_TERMINAL_VALUE", value: "ok" }],
    cwd: process.cwd(),
    outputByteLimit: 7,
  });
  assert.equal(typeof created.terminalId, "string");
  const identity = { sessionId: "session-one", terminalId: created.terminalId };
  assert.deepEqual(await terminal.request("terminal/wait_for_exit", identity), {
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(await terminal.request("terminal/output", identity), {
    output: ":αβγ",
    truncated: true,
    exitStatus: { exitCode: 0, signal: null },
  });
  assert.deepEqual(await terminal.request("terminal/release", identity), {});
  await assert.rejects(terminal.request("terminal/output", identity), /Unknown ACP terminal/u);
});

test("disposing the ACP terminal host kills unreleased commands", async () => {
  const terminal = host();
  await terminal.request("terminal/create", {
    sessionId: "session-two",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  await terminal.dispose();
});

test("ACP terminal supports Grok's full shell line compatibility mode", async () => {
  const terminal = host({ shellCommand: true });
  const created = await terminal.request("terminal/create", {
    sessionId: "session-shell",
    command: `"${process.execPath}" -e "process.stdout.write('shell-ok')"`,
  });
  const identity = { sessionId: "session-shell", terminalId: created.terminalId };
  await terminal.request("terminal/wait_for_exit", identity);
  assert.deepEqual(await terminal.request("terminal/output", identity), {
    output: "shell-ok",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  });
});
