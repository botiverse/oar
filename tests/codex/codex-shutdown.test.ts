import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { codexAccountUsage } from "../../packages/oar/src/runtimes/codex/account-usage.js";
import { codexSkills } from "../../packages/oar/src/runtimes/codex/inventory.js";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";

const FAKE_CODEX_SCRIPT = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.env.OAR_SHUTDOWN_MARKER;
let signaled = false;
let activeTurn = false;
process.on("SIGTERM", () => {
  signaled = true;
  if (marker) writeFileSync(marker, "signaled");
  process.exit(143);
});
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req?.id === undefined) return;
  let result = {};
  switch (req.method) {
    case "initialize":
      result = { userAgent: "codex/0.171.0" };
      break;
    case "account/read":
      result = { account: { type: "chatgpt", email: "probe@example.invalid", planType: "pro" }, requiresOpenaiAuth: true };
      break;
    case "account/rateLimits/read":
      result = { rateLimits: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300 } } };
      break;
    case "model/list":
      result = { data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null };
      break;
    case "config/read":
      result = { config: { model: "gpt-5.4" } };
      break;
    case "skills/list":
      result = { data: [{ cwd: req.params?.cwds?.[0] ?? ".", skills: [], errors: [] }] };
      break;
    case "thread/start":
      result = { thread: { id: "thread-1" }, model: "gpt-5.4" };
      break;
    case "turn/start":
      activeTurn = true;
      result = { turn: { id: "turn-1" } };
      process.stdout.write(JSON.stringify({ id: req.id, result }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }) + "\\n");
      return;
    default:
      result = {};
  }
  process.stdout.write(JSON.stringify({ id: req.id, result }) + "\\n");
});
rl.on("close", () => {
  setTimeout(() => {
    if (!signaled && marker) writeFileSync(marker, "eof_clean");
    process.exit(0);
  }, activeTurn ? 3000 : 80);
});
`;

async function createFakeCodex(): Promise<{ readonly command: string; readonly dir: string; readonly marker: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-codex-eof-"));
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const script = path.join(dir, "fake-codex.mjs");
  const marker = path.join(dir, "shutdown.txt");
  await writeFile(script, process.platform === "win32" ? FAKE_CODEX_SCRIPT : `#!${process.execPath}\n${FAKE_CODEX_SCRIPT}`);
  const command = process.platform === "win32" ? path.join(dir, "fake-codex.cmd") : script;
  await (process.platform === "win32" ? writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`) : chmod(script, 0o755));
  return { command, dir, marker };
}

test("codexAccountUsage lets app-server exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeCodex();
  const result = await codexAccountUsage({ kind: "available", via: "executable", command: fake.command, version: "0.171.0" }, {
    env: { CODEX_HOME: fake.dir, OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("available");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("codexListModels lets app-server exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeCodex();
  const result = await codexListModels({ kind: "available", via: "executable", command: fake.command, version: "0.171.0" }, {
    cwd: fake.dir,
    env: { CODEX_HOME: fake.dir, OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("ok");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("codexSkills lets app-server exit via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeCodex();
  const result = await codexSkills({ kind: "available", via: "executable", command: fake.command, version: "0.171.0" }, {
    cwd: fake.dir,
    env: { CODEX_HOME: fake.dir, OAR_SHUTDOWN_MARKER: fake.marker },
  });
  expect(result.kind).toBe("ok");
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("codexSession idle dispose exits via stdin EOF without immediate SIGTERM", async () => {
  const fake = await createFakeCodex();
  const session = await codexSession({ kind: "available", via: "executable", command: fake.command, version: "0.171.0" }, {
    cwd: fake.dir,
    env: { CODEX_HOME: fake.dir, OAR_SHUTDOWN_MARKER: fake.marker },
  });
  await session.dispose();
  expect(await readFile(fake.marker, "utf8")).toBe("eof_clean");
});

test("codexSession active-turn dispose terminates immediately instead of waiting on EOF", async () => {
  const fake = await createFakeCodex();
  const session = await codexSession({ kind: "available", via: "executable", command: fake.command, version: "0.171.0" }, {
    cwd: fake.dir,
    env: { CODEX_HOME: fake.dir, OAR_SHUTDOWN_MARKER: fake.marker },
  });
  await session.prompt("hold");
  await session.dispose();
  if (process.platform === "win32") {
    expect(existsSync(fake.marker)).toBe(false);
  } else {
    expect(await readFile(fake.marker, "utf8")).toBe("signaled");
  }
});
