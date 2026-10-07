import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { sweepAbandonedMcpConfigs } from "../../packages/oar/src/runtimes/claude/mcp-config.js";

/*
 * A host killed by a signal before claude has read its MCP config (the
 * startup window): no plaintext reaches the disk, and the claude left waiting
 * on the FIFO goes when the next claude session starts (it sweeps). Real
 * processes: the host is a fresh node running launchClaude, claude is a shell
 * script that reads its --mcp-config the way claude does (a blocking open).
 */

const launchUrl = pathToFileURL(path.join(import.meta.dirname, "../../packages/oar/src/runtimes/claude/launch.ts")).href;
const SECRET = "host-death-credential-value";

const FAKE_CLAUDE = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then config="$2"; fi
  shift
done
printf '%s' "$config" > "$OAR_FAKE_OUT.path"
sleep 1
cat "$config" > "$OAR_FAKE_OUT.part"
mv "$OAR_FAKE_OUT.part" "$OAR_FAKE_OUT"
`;

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling.
    await delay(20);
  }
  return done();
}

/** A claude stand-in in `scratch` that reads its --mcp-config a second after it starts into `<scratch>/read`; that path. */
function fakeClaude(scratch: string): { readonly command: string; readonly out: string } {
  const command = path.join(scratch, "claude");
  writeFileSync(command, FAKE_CLAUDE);
  chmodSync(command, 0o755);
  return { command, out: path.join(scratch, "read") };
}

/** A host that launches `command` with an MCP server holding SECRET and SIGKILLs itself at once: the config directory it gave claude. */
async function killedHost(command: string, out: string, scratch: string): Promise<string> {
  const options = { cwd: scratch, env: { OAR_FAKE_OUT: out }, mcpServers: [{ name: "echo", command: "node", env: { OAR_ECHO_TOKEN: SECRET } }] };
  const script = `import { launchClaude } from ${JSON.stringify(launchUrl)};
await launchClaude(${JSON.stringify(command)}, "session-1", ${JSON.stringify(options)});
console.log(process.pid);
process.kill(process.pid, "SIGKILL");`;
  const hostRun = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 20_000, encoding: "utf8" });
  expect(hostRun.signal).toBe("SIGKILL");
  assert.ok(await until(() => existsSync(`${out}.path`), 5000), "claude never started");
  const directory = path.dirname(readFileSync(`${out}.path`, "utf8"));
  expect(path.basename(directory).startsWith(`oar-claude-mcp-${hostRun.stdout.trim()}-`)).toBe(true);
  return directory;
}

/** What is in `directory`, each entry a FIFO or not; nothing when it is gone already (another test's claude session swept it). */
function entries(directory: string): readonly { readonly name: string; readonly fifo: boolean }[] {
  return existsSync(directory) ? readdirSync(directory).map((name) => ({ name, fifo: lstatSync(path.join(directory, name)).isFIFO() })) : [];
}

test.skipIf(process.platform === "win32")("a host SIGKILLed before claude reads leaves no plaintext, and the next claude session lets the waiting claude go", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "oar-test-host-death-"));
  try {
    const { command, out } = fakeClaude(scratch);
    const directory = await killedHost(command, out, scratch);
    // What the dead host left: a FIFO, nothing that holds a byte.
    expect(entries(directory).filter((entry) => !entry.fifo)).toEqual([]);
    // claude waits on the FIFO, where no writer will come, until a sweep releases it.
    await sweepAbandonedMcpConfigs();
    expect(await until(() => existsSync(out), 5000)).toBe(true);
    expect({ read: readFileSync(out, "utf8"), directory: existsSync(directory) }).toEqual({ read: "", directory: false });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
