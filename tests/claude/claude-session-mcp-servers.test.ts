import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;

const STDIO_TOKEN = "stdio-secret-value";
const HEADER = "Bearer header-secret-value";
const echo: McpServer = { name: "echo", command: "/usr/bin/node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: STDIO_TOKEN } };
const servers: readonly McpServer[] = [echo, { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: HEADER } }];

afterEach(() => {
  spawnLineProcess.mockReset();
});

/** The `--mcp-config` path of the one spawn so far, and the whole argv. */
function spawned(): { readonly argv: readonly string[]; readonly config: string | null } {
  const argv = spawnLineProcess.mock.calls[0]?.[1] ?? [];
  const at = argv.indexOf("--mcp-config");
  return { argv, config: at === -1 ? null : argv[at + 1] ?? null };
}

/** The argv holds the config's path, never a credential, and no --strict-mcp-config (the user's own servers stay loaded); the path is 0600, a FIFO where the platform has them. */
function assertConfigPath(argv: readonly string[], config: string): void {
  expect(argv).not.toContain("--strict-mcp-config");
  expect([STDIO_TOKEN, HEADER].filter((secret) => JSON.stringify(argv).includes(secret))).toEqual([]);
  if (process.platform !== "win32") {
    const entry = lstatSync(config);
    expect({ fifo: entry.isFIFO(), mode: entry.mode & 0o777 }).toEqual({ fifo: true, mode: 0o600 });
  }
}

/** Until `done`, polling: the FIFO handoff finishes on its own schedule. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    // oxlint-disable-next-line no-await-in-loop -- polling.
    await delay(10);
  }
}

const fifos = process.platform !== "win32";

/** Read the first bytes of `config` the way claude would, then close it: how many arrived. */
async function readSomeAndLeave(config: string): Promise<number> {
  const reader = await open(config, "r");
  const { bytesRead } = await reader.read(Buffer.alloc(1024), 0, 1024, null);
  await reader.close();
  return bytesRead;
}

test("mcpServers reach claude through --mcp-config, never argv: a FIFO gone once read (a file gone with the session where there are no FIFOs)", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess());
  const session = await claudeSession(installation, { cwd: "/work", mcpServers: servers });
  const { argv, config } = spawned();
  assert.ok(config !== null, `no --mcp-config in ${JSON.stringify(argv)}`);
  assertConfigPath(argv, config);
  // What claude reads; on a FIFO it is never on a disk.
  expect(JSON.parse(await readFile(config, "utf8"))).toMatchInlineSnapshot(`
    {
      "mcpServers": {
        "echo": {
          "args": [
            "echo.mjs",
          ],
          "command": "/usr/bin/node",
          "env": {
            "OAR_ECHO_TOKEN": "stdio-secret-value",
          },
          "type": "stdio",
        },
        "remote": {
          "headers": {
            "Authorization": "Bearer header-secret-value",
          },
          "type": "http",
          "url": "http://127.0.0.1:9/mcp",
        },
      },
    }
  `);
  if (fifos) {
    await until(() => !existsSync(path.dirname(config)));
  }
  await session.dispose();
  expect(existsSync(path.dirname(config))).toBe(false);
});

test("a resume passes them again: claude remembers no --mcp-config", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: {} } })}\n`);
  }));
  const session = await claudeSession(installation, { cwd: "/work", resume: "claude-session-1", mcpServers: servers });
  const { argv, config } = spawned();
  expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", "claude-session-1"]);
  expect(config).not.toBeNull();
  await session.dispose();
});

test("claude exiting before it reads the config removes it too", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work", mcpServers: servers });
  const { config } = spawned();
  assert.ok(config !== null);
  fake.end(1);
  await fake.exited;
  expect(existsSync(path.dirname(config))).toBe(false);
  await session.dispose();
});

test.skipIf(!fifos)("claude exiting in the middle of reading: the handoff stops and the directory goes", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  // Larger than a pipe holds, so the write is still going when the reader leaves.
  const large: McpServer = { name: "large", command: "/usr/bin/node", env: { OAR_LARGE: "x".repeat(1024 * 1024) } };
  const session = await claudeSession(installation, { cwd: "/work", mcpServers: [large] });
  const { config } = spawned();
  assert.ok(config !== null);
  expect(await readSomeAndLeave(config)).toBeGreaterThan(0);
  fake.end(1);
  await session.dispose();
  expect(existsSync(path.dirname(config))).toBe(false);
});

test("no servers, or an empty list, pass no --mcp-config", async () => {
  for (const mcpServers of [undefined, []]) {
    spawnLineProcess.mockReturnValue(fakeLineProcess());
    // oxlint-disable-next-line no-await-in-loop -- one session at a time, so the spawn read is this one's.
    const session = await claudeSession(installation, { cwd: "/work", ...(mcpServers === undefined ? {} : { mcpServers }) });
    expect(spawned().config).toBeNull();
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await session.dispose();
    spawnLineProcess.mockReset();
  }
});

test("a name given twice refuses the open before claude starts", async () => {
  await expect(claudeSession(installation, { cwd: "/work", mcpServers: [echo, { name: "echo", command: "other" }] })).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: mcpServers names "echo" twice; names are unique within a session]`);
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
