import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession } from "../../packages/oar/src/index.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { runTurn } from "./support/asserts.js";
import { startClaudeAimock } from "../harness/aimock.js";

/*
 * PROBE, NOT FOR MERGE (draft PR on top of fix/windows-cmd-double-escaping).
 * Windows-only evidence for oar#434, gathered on windows-latest so Otter can
 * set the yarn-follow and command-line-length boundaries from real behavior:
 *
 *   A. yarn's real global shim shape (is it .cmd -> .cmd, or a node shim?).
 *   B. cmd.exe's 8191-char command-line limit: explicit error or silent cut?
 *   C. agreed re-verification: real claude.cmd carries injection payloads
 *      through --append-system-prompt intact; argv survives an unrecognized
 *      hand-written .cmd via spawnLineProcess, verbatim.
 *   D. PowerShell tool: with Git Bash hidden and no env var, does claude
 *      expose PowerShell, and is its input schema Bash's shape?
 *
 * Each section is independent and prints PROBE lines; the only hard assertion
 * is that the probe ran. Read the CI log, not a pass/fail.
 */

const lines: string[] = [];
const log = (line: string): void => { lines.push(line); };
const clip = (value: unknown, n = 400): string => JSON.stringify(value).slice(0, n);
const payloads = [
  'a" & b', 'a" | b', 'a "b" c" & d', 'say "hi" | x',
  "100%PATH% and %%", "caret^here ^^ end^", "C:\\dir with space\\", "unicode é中文",
] as const;

/** A tiny Node script that writes its argv as JSON to the file in LK_OUT, then an npm-style node shim that calls it. */
function argvRecorder(dir: string): { script: string } {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "argv.cjs");
  writeFileSync(script, "require('fs').writeFileSync(process.env.LK_OUT, JSON.stringify(process.argv.slice(2)));\n");
  return { script };
}

/** An absolute-target hand-written .cmd (parser leaves it unrecognized -> cmd.exe fallback). */
function handwrittenCmd(dir: string, script: string): string {
  const command = path.join(dir, "rec.cmd");
  writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return command;
}

async function runRecorder(command: string, args: readonly string[], outFile: string): Promise<{ argv: unknown; exit: number | null }> {
  rmSync(outFile, { force: true });
  const child = spawnLineProcess(command, args, { env: { ...process.env, LK_OUT: outFile } });
  const exit = await child.exited;
  const stderr = child.diagnostics().stderr;
  const argv: unknown = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : `(no output) stderr=${stderr.slice(0, 160)}`;
  return { argv, exit };
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock" || process.platform !== "win32")("PROBE windows .cmd fallback (oar#434)", () => {
  test("A. yarn global shim real shape", () => {
    // Run from a temp cwd with its own package.json so corepack does not read
    // the repo's packageManager pin, and fetch classic yarn through npx so the
    // call never goes through corepack's `yarn` shim.
    const home = mkdtempSync(path.join(tmpdir(), "lk-yarn-"));
    writeFileSync(path.join(home, "package.json"), '{"name":"lk-probe","version":"1.0.0","private":true}\n');
    const globalFolder = path.join(home, "yarn-global");
    const env = { ...process.env, YARN_GLOBAL_FOLDER: globalFolder, npm_config_prefix: home, COREPACK_ENABLE_STRICT: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
    const common = { shell: true, encoding: "utf8" as const, env, cwd: home };
    const ver = spawnSync("npx", ["--yes", "yarn@1.22.22", "--version"], { ...common, timeout: 180_000 });
    log(`PROBE A yarn --version: status=${String(ver.status)} v=${JSON.stringify(ver.stdout.trim())} stderr=${JSON.stringify(ver.stderr.trim()).slice(0, 160)}`);
    const add = spawnSync("npx", ["--yes", "yarn@1.22.22", "global", "add", "--prefix", home, "cowsay@1.5.0"], { ...common, timeout: 300_000 });
    log(`PROBE A yarn global add: status=${String(add.status)} stderr=${JSON.stringify(add.stderr.trim()).slice(0, 300)}`);
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || !existsSync(dir)) { return; }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); }
        else if (entry.name.toLowerCase().endsWith(".cmd")) { found.push(full); }
      }
    };
    walk(home, 0);
    log(`PROBE A found ${String(found.length)} .cmd under ${home}`);
    for (const file of found.slice(0, 8)) { log(`PROBE A shim ${file}:\n${readFileSync(file, "utf8")}`); }
    rmSync(home, { recursive: true, force: true });
  }, 360_000);

  test("B. cmd.exe 8191 command-line limit: error or silent truncation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lk-len-"));
    try {
      const { script } = argvRecorder(dir);
      const command = handwrittenCmd(dir, script);
      const out = path.join(dir, "out.json");
      // A single argument whose escaped form pushes the whole line past 8191.
      const big = "A".repeat(9000);
      const { argv, exit } = await runRecorder(command, ["--append-system-prompt", big], out);
      const received = Array.isArray(argv) && typeof argv[1] === "string" ? argv[1] : null;
      const got = received === null ? -1 : received.length;
      log(`PROBE B len9000: exit=${String(exit)} receivedArgLen=${received === null ? clip(argv) : String(got)} (sent 9000)`);
      log(got === 9000 ? "PROBE B -> delivered whole (no limit hit)" : "PROBE B -> NOT whole: either cmd error (nonzero exit, no output) or SILENT TRUNCATION (arg shorter)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("C1. real claude.cmd carries payloads through --append-system-prompt", async () => {
    const installation = await claudeInstallation();
    if (installation.kind !== "available" || installation.via !== "executable") { log(`PROBE C1 claude ${installation.kind}; skip`); return; }
    log(`PROBE C1 claude command: ${installation.command} (v${installation.version ?? "?"})`);
    for (const value of payloads) {
      const marker = `[[LK:${value}:LK]]`;
      const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
      let outcome = "";
      try {
        const session = await claudeSession(installation, { cwd: process.cwd(), ...(env.env === undefined ? {} : { env: env.env }), appendSystemPrompt: marker });
        try { const turn = await runTurn(session, "probe"); outcome = turn.kind; } finally { await session.dispose(); }
      } catch (error) { outcome = `threw ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`; } finally { await env.stop(); }
      // The body is JSON, so the marker appears with quotes and backslashes escaped.
      const needle = JSON.stringify(marker).slice(1, -1);
      const whole = env.raw.map((r) => JSON.stringify(r.body)).some((t) => t.includes(needle));
      const head = env.raw.map((r) => { const t = JSON.stringify(r.body); const at = t.indexOf("[[LK:"); return at === -1 ? "" : t.slice(at, at + 120); }).find((s) => s !== "") ?? "(none)";
      log(`PROBE C1 ${whole ? "WHOLE" : "LOST "} value=${JSON.stringify(value)} outcome=${outcome} reqs=${String(env.raw.length)}${whole ? "" : ` head=${head}`}`);
    }
  }, 300_000);

  test("C2. argv survives an unrecognized hand-written .cmd via spawnLineProcess", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lk dir with space "));
    try {
      const { script } = argvRecorder(dir);
      const command = handwrittenCmd(dir, script);
      const out = path.join(dir, "out.json");
      const marker = path.join(dir, "INJECTED.txt");
      const args = ["--append-system-prompt", `a" & echo X > "${marker}" & rem "`, ...payloads, "%OAR_SENTINEL%"];
      const { argv, exit } = await runRecorder(command, args, out);
      const same = JSON.stringify(argv) === JSON.stringify(args);
      log(`PROBE C2 exit=${String(exit)} verbatim=${String(same)} injected=${String(existsSync(marker))} argv=${clip(argv, 500)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("D. PowerShell tool appears without Git Bash and without the env var", async () => {
    const bash = [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files (x86)\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`];
    const hidden: string[] = [];
    for (const file of bash) {
      if (!existsSync(file)) { continue; }
      try { renameSync(file, `${file}.lkhidden`); hidden.push(file); } catch (error) { log(`PROBE D could not hide ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    log(`PROBE D hid ${String(hidden.length)} bash.exe: ${JSON.stringify(hidden)}`);
    const env0: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) { if (value !== undefined && key.toUpperCase() !== "CLAUDE_CODE_USE_POWERSHELL_TOOL") { env0[key] = value; } }
    try {
      const installation = await claudeInstallation();
      if (installation.kind !== "available" || installation.via !== "executable") { log(`PROBE D claude ${installation.kind}; skip`); return; }
      const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
      try {
        const session = await claudeSession(installation, { cwd: process.cwd(), env: { ...env0, ...env.env } });
        try { await runTurn(session, "probe"); } finally { await session.dispose(); }
      } finally { await env.stop(); }
      const bodies = env.raw.map((request) => JSON.stringify(request.body));
      log(`PROBE D PowerShell=${String(bodies.some((t) => t.includes('"name":"PowerShell"')))} Bash=${String(bodies.some((t) => t.includes('"name":"Bash"')))}`);
      for (const marker of ['"name":"PowerShell"', '"name":"Bash"']) {
        const body = bodies.find((t) => t.includes(marker));
        if (body === undefined) { continue; }
        // The window after the name shows the tool's own input_schema inline.
        log(`PROBE D window ${marker}: ${body.slice(body.indexOf(marker), body.indexOf(marker) + 1800)}`);
      }
    } finally {
      for (const file of hidden) { try { renameSync(`${file}.lkhidden`, file); } catch { /* restore best effort */ } }
    }
  }, 120_000);

  test("print", () => { for (const line of lines) { console.log(line); } expect(lines.length).toBeGreaterThan(0); });
});
