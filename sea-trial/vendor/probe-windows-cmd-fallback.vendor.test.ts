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

/** Capture one claude turn's tools from the provider request, as the serialized request bodies. */
async function captureToolBodies(installation: Parameters<typeof claudeSession>[0], extraEnv: Record<string, string>): Promise<readonly string[]> {
  const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
  try {
    const session = await claudeSession(installation, { cwd: process.cwd(), env: { ...extraEnv, ...env.env } });
    try { await runTurn(session, "probe"); } finally { await session.dispose(); }
  } finally { await env.stop(); }
  return env.raw.map((request) => JSON.stringify(request.body));
}

/** The top-level property keys and `required` list of one named tool's input_schema, scanned from the serialized body (brace-aware, no JSON parse of `unknown`). */
function schemaOf(bodies: readonly string[], toolName: string): { present: boolean; props: string[]; required: string } {
  const body = bodies.find((t) => t.includes(`"name":"${toolName}"`));
  if (body === undefined) { return { present: false, props: [], required: "" }; }
  const from = body.indexOf(`"name":"${toolName}"`);
  const schemaAt = body.indexOf('"properties":{', from);
  const props: string[] = [];
  if (schemaAt !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let keyStart = -1;
    for (let i = body.indexOf("{", schemaAt); i < body.length; i += 1) {
      const character = body[i];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') { if (!inString && depth === 1) { keyStart = i + 1; } else if (inString && depth === 1 && keyStart !== -1) { props.push(body.slice(keyStart, i)); keyStart = -1; } inString = !inString; continue; }
      if (inString) { continue; }
      if (character === "{") { depth += 1; }
      else if (character === "}") { depth -= 1; if (depth === 0) { break; } }
    }
  }
  const requiredMatch = /"required":(\[[^\]]*\])/u.exec(body.slice(from));
  return { present: true, props, required: requiredMatch?.[1] ?? "(none)" };
}

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

  test("E. a real two-layer yarn-shaped shim: argv verbatim, no injection (exercises the shim follow)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lk yarn two layer "));
    try {
      // Inner: a cmd-shim node shim (the shape OAR recognizes) wrapping the argv recorder.
      const inner = path.join(dir, "node_modules", ".bin");
      const { script } = argvRecorder(inner);
      writeFileSync(path.join(inner, "rec.cmd"), `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "${script}" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "${script}" %*\r\n)\r\n`);
      // Outer: the yarn global forwarder, a bare relative .cmd target plus %*.
      const outerDir = path.join(dir, "bin");
      mkdirSync(outerDir, { recursive: true });
      const outer = path.join(outerDir, "rec.cmd");
      writeFileSync(outer, `@"%~dp0\\..\\node_modules\\.bin\\rec.cmd"   %*\r\n`);
      const out = path.join(dir, "out.json");
      const marker = path.join(dir, "INJECTED.txt");
      const args = ["--append-system-prompt", `a" & echo X > "${marker}" & rem "`, ...payloads, "%OAR_SENTINEL%"];
      const { argv, exit } = await runRecorder(outer, args, out);
      const same = JSON.stringify(argv) === JSON.stringify(args);
      log(`PROBE E (two-layer yarn shim) exit=${String(exit)} verbatim=${String(same)} injected=${String(existsSync(marker))} argv=${clip(argv, 500)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("D. PowerShell tool appears without Git Bash, with Bash's input shape", async () => {
    const installation = await claudeInstallation();
    if (installation.kind !== "available" || installation.via !== "executable") { log(`PROBE D claude ${installation.kind}; skip`); return; }
    const noPwshEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) { if (value !== undefined && key.toUpperCase() !== "CLAUDE_CODE_USE_POWERSHELL_TOOL") { noPwshEnv[key] = value; } }

    // Baseline: Git Bash present -> claude should offer Bash. Record its schema for comparison.
    const bashBodies = await captureToolBodies(installation, noPwshEnv);
    const bashSchema = schemaOf(bashBodies, "Bash");
    log(`PROBE D baseline (Git Bash present): Bash=${String(bashSchema.present)} PowerShell=${String(schemaOf(bashBodies, "PowerShell").present)}`);
    log(`PROBE D Bash props=${clip(bashSchema.props)} required=${bashSchema.required}`);

    // Now hide Git Bash and, with no env var, see what claude offers.
    const bash = [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files (x86)\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`];
    const hidden: string[] = [];
    for (const file of bash) {
      if (!existsSync(file)) { continue; }
      try { renameSync(file, `${file}.lkhidden`); hidden.push(file); } catch (error) { log(`PROBE D could not hide ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    log(`PROBE D hid ${String(hidden.length)} bash.exe: ${JSON.stringify(hidden)}`);
    try {
      const bodies = await captureToolBodies(installation, noPwshEnv);
      const pwsh = schemaOf(bodies, "PowerShell");
      log(`PROBE D no-git-bash: PowerShell=${String(pwsh.present)} Bash=${String(schemaOf(bodies, "Bash").present)}`);
      log(`PROBE D PowerShell props=${clip(pwsh.props)} required=${pwsh.required}`);
      log(`PROBE D props match Bash: ${String(JSON.stringify(pwsh.props) === JSON.stringify(bashSchema.props))}; required match: ${String(pwsh.required === bashSchema.required)}`);
    } finally {
      for (const file of hidden) { try { renameSync(`${file}.lkhidden`, file); } catch { /* restore best effort */ } }
    }
  }, 180_000);

  test("print", () => { for (const line of lines) { console.log(line); } expect(lines.length).toBeGreaterThan(0); });
});
