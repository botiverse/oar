import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { factoryAuthStatus } from "../../packages/oar/src/runtimes/factory/account.js";

const FAKE_DROID_ACP_SCRIPT = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

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
  if (req?.id === undefined) return;
  const result = req.method === "auth/status"
    ? { state: "authenticated", accounts: [{ label: "probe@example.invalid", active: true }] }
    : { protocolVersion: 1, authMethods: [], agentCapabilities: { auth: { status: true, logout: true } } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
});
rl.on("close", () => {
  setTimeout(() => {
    if (!signaled && marker) writeFileSync(marker, "eof_clean");
    process.exit(0);
  }, 80);
});
`;

test("factoryAuthStatus lets droid ACP exit via stdin EOF without immediate SIGTERM", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-factory-eof-"));
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const script = path.join(dir, "fake-droid.mjs");
  const marker = path.join(dir, "shutdown.txt");
  await writeFile(script, process.platform === "win32" ? FAKE_DROID_ACP_SCRIPT : `#!${process.execPath}\n${FAKE_DROID_ACP_SCRIPT}`);
  const command = process.platform === "win32" ? path.join(dir, "fake-droid.cmd") : script;
  await (process.platform === "win32" ? writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`) : chmod(script, 0o755));

  const status = await factoryAuthStatus({ kind: "available", via: "executable", command, version: "1.16.0" }, {
    env: { OAR_SHUTDOWN_MARKER: marker },
  });
  expect(status).toMatchObject({ kind: "logged_in" });
  expect(await readFile(marker, "utf8")).toBe("eof_clean");
});
