import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  createAcpTerminalHost,
  type AcpTerminalHost,
  type AcpTerminalHostOptions,
} from "../../packages/oar/src/shared/acp/terminal.js";
import { eventually, gone, timed } from "../fixtures/process-tree.js";

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
  const created = await terminal.create({
    sessionId: "session-one",
    command: process.execPath,
    args: ["-e", "process.stdout.write((process.env.OAR_TERMINAL_VALUE ?? '') + ':αβγ')"],
    env: [{ name: "OAR_TERMINAL_VALUE", value: "ok" }],
    cwd: process.cwd(),
    outputByteLimit: 7,
  });
  assert.equal(typeof created.terminalId, "string");
  const identity = { sessionId: "session-one", terminalId: created.terminalId };
  assert.deepEqual(await terminal.waitForExit(identity), {
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(terminal.output(identity), {
    output: ":αβγ",
    truncated: true,
    exitStatus: { exitCode: 0, signal: null },
  });
  assert.deepEqual(await terminal.release(identity), {});
  assert.throws(() => terminal.output(identity), /Unknown ACP terminal/u);
});

test("disposing the ACP terminal host kills unreleased commands", async () => {
  const terminal = host();
  await terminal.create({
    sessionId: "session-two",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  await terminal.dispose();
});

test("ACP terminal supports Grok's full shell line compatibility mode", async () => {
  const terminal = host({ shellCommand: true });
  const created = await terminal.create({
    sessionId: "session-shell",
    command: `"${process.execPath}" -e "process.stdout.write('shell-ok')"`,
  });
  const identity = { sessionId: "session-shell", terminalId: created.terminalId };
  await terminal.waitForExit(identity);
  assert.deepEqual(terminal.output(identity), {
    output: "shell-ok",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  });
});

// POSIX process groups: the shell's background job holds the output pipes, so
// a kill that reached only the shell left the release waiting on it.
test.skipIf(process.platform === "win32")("releasing a terminal takes down what its command started, so the release settles", async () => {
  const terminal = host({ shellCommand: true });
  const created = await terminal.create({ sessionId: "session-tree", command: "sleep 60 & echo $!; wait" });
  const identity = { sessionId: "session-tree", terminalId: created.terminalId };
  const job = (): number | null => {
    const pid = /^\d+/u.exec(terminal.output(identity).output)?.[0];
    return pid === undefined ? null : Number(pid);
  };
  assert.ok(await eventually(() => job() !== null, 5000), `the shell reported its background job: ${JSON.stringify(terminal.output(identity))}`);
  const tool = job() ?? Number.NaN;
  const elapsed = await timed(async () => terminal.release(identity));
  assert.ok(elapsed < 2000, `release settled ${elapsed.toFixed(0)} ms after it was called`);
  assert.equal(await gone(tool), true, "the background job is gone");
});
