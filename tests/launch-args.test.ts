import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

// SessionOptions.launchArgs (oar#250): the host's own flags, passed unchecked
// where each runtime's CLI takes options, and never recorded.

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

afterEach(() => {
  spawnLineProcess.mockReset();
});

const SECRET = "launch-arg-secret-sentinel";

function argv(): readonly string[] {
  return spawnLineProcess.mock.calls[0]?.[1] ?? [];
}

function expectNotRecorded(session: Session): void {
  expect(JSON.stringify(session.records())).not.toContain(SECRET);
}

/** After oar's own flags, before the variadic --disallowed-tools. */
function expectClaudePlacement(args: readonly string[], launchArgs: readonly string[]): void {
  const at = args.indexOf(launchArgs[0] ?? "");
  expect(args.slice(at, at + launchArgs.length)).toEqual(launchArgs);
  expect(at).toBeGreaterThan(args.indexOf("--dangerously-skip-permissions"));
  expect(at).toBeLessThan(args.indexOf("--disallowed-tools"));
}

/** app-server, oar's -c overrides, the host's arguments, --listen stdio://. */
function expectCodexPlacement(args: readonly string[], launchArgs: readonly string[]): void {
  expect(args.slice(0, 3)).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
  expect(args.slice(-2 - launchArgs.length)).toEqual([...launchArgs, "--listen", "stdio://"]);
}

test("claude: the host's flags go after oar's own and before the variadic --mcp-config and --disallowed-tools", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess(() => {}));
  const launchArgs = ["--add-dir", "/extra", "--settings", `{"token":"${SECRET}"}`];
  const session = await claudeSession({ kind: "available", via: "executable", command: "claude", version: "2.1.293" }, {
    cwd: "/work", launchArgs, disallowedTools: ["Bash"],
  });
  try {
    expectClaudePlacement(argv(), launchArgs);
    expectNotRecorded(session);
  } finally {
    await session.dispose();
  }
});

test("codex: the host's flags go after oar's -c overrides and before --listen", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") { return; }
    const result = message.method === "initialize" ? {} : { thread: { id: "thread-1" }, model: "gpt-5.5" };
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  }));
  const launchArgs = ["-c", 'service_tier="fast"', "-c", `note="${SECRET}"`];
  const session = await codexSession({ kind: "available", via: "executable", command: "codex", version: "0.161.0" }, { cwd: "/work", launchArgs });
  try {
    expectCodexPlacement(argv(), launchArgs);
    expectNotRecorded(session);
  } finally {
    await session.dispose();
  }
});
