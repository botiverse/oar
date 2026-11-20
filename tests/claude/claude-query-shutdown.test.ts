import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { claudeAccountUsage } from "../../packages/oar/src/runtimes/claude/account-usage.js";
import { claudeSkills } from "../../packages/oar/src/runtimes/claude/inventory.js";
import { claudeListModels } from "../../packages/oar/src/runtimes/claude/list-models.js";

const FAKE_CLAUDE_SCRIPT = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--help")) {
  process.stdout.write("--safe-mode\\n");
  process.exit(0);
}
const marker = process.env.OAR_SHUTDOWN_MARKER;
let signaled = false;
process.on("SIGTERM", () => {
  signaled = true;
  if (marker) writeFileSync(marker, "signaled");
  process.exit(143);
});
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const sub = req?.request?.subtype;
  let response = {};
  if (sub === "list_models") response = { models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5" }] };
  else if (sub === "initialize") response = { account: { email: "probe@example.invalid" }, commands: [] };
  else if (sub === "get_usage") response = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 10, resets_at: "2026-11-20T10:00:00Z" } } };
  else if (sub === "get_context_usage") response = { skills: { skillFrontmatter: [] } };
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } }) + "\\n");
});
rl.on("close", () => {
  setTimeout(() => {
    if (!signaled && marker) writeFileSync(marker, "eof_clean");
    process.exit(0);
  }, 80);
});
`;

async function createFakeClaude(): Promise<{ readonly command: string; readonly dir: string; readonly marker: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-claude-query-eof-"));
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const script = path.join(dir, "fake-claude.mjs");
  const marker = path.join(dir, "shutdown.txt");
  await writeFile(script, process.platform === "win32" ? FAKE_CLAUDE_SCRIPT : `#!${process.execPath}\n${FAKE_CLAUDE_SCRIPT}`);
  const command = process.platform === "win32" ? path.join(dir, "fake-claude.cmd") : script;
  await (process.platform === "win32" ? writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`) : chmod(script, 0o755));
  return { command, dir, marker };
}

test("claudeListModels lets claude exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeClaude();
  const result = await claudeListModels({ kind: "available", via: "executable", command: fake.command, version: "2.1.328" }, {
    cwd: fake.dir,
    env: { OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("ok");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("claudeAccountUsage lets claude exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeClaude();
  const result = await claudeAccountUsage({ kind: "available", via: "executable", command: fake.command, version: "2.1.328" }, {
    env: { OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("available");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("claudeSkills lets claude exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeClaude();
  const result = await claudeSkills({ kind: "available", via: "executable", command: fake.command, version: "2.1.328" }, {
    cwd: fake.dir,
    env: { OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("ok");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});
