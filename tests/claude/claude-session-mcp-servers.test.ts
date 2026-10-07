import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
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

/** The argv holds the file's path, never a credential, and no --strict-mcp-config (the user's own servers stay loaded); the file is 0600. */
function assertConfigFile(argv: readonly string[], config: string): void {
  expect(argv).not.toContain("--strict-mcp-config");
  expect([STDIO_TOKEN, HEADER].filter((secret) => JSON.stringify(argv).includes(secret))).toEqual([]);
  if (process.platform !== "win32") {
    expect(statSync(config).mode & 0o777).toBe(0o600);
  }
}

test("mcpServers reach claude as a 0600 --mcp-config file, never as argv, removed when the session ends", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess());
  const session = await claudeSession(installation, { cwd: "/work", mcpServers: servers });
  const { argv, config } = spawned();
  assert.ok(config !== null, `no --mcp-config in ${JSON.stringify(argv)}`);
  assertConfigFile(argv, config);
  expect(JSON.parse(readFileSync(config, "utf8"))).toMatchInlineSnapshot(`
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
  await session.dispose();
  expect(existsSync(config)).toBe(false);
});

test("a resume passes them again: claude remembers no --mcp-config", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess());
  const session = await claudeSession(installation, { cwd: "/work", resume: "claude-session-1", mcpServers: servers });
  const { argv, config } = spawned();
  expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", "claude-session-1"]);
  expect(config).not.toBeNull();
  await session.dispose();
});

test("claude exiting on its own removes the file too", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work", mcpServers: servers });
  const { config } = spawned();
  assert.ok(config !== null);
  fake.end(1);
  await fake.exited;
  expect(existsSync(config)).toBe(false);
  await session.dispose();
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
