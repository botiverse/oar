/* oxlint-disable max-statements -- Exercise the actual shell, stdin and quoting, then compare the previous Windows expression. */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { directoryHookCommand } from "../experiments/sharing/directory-configuration.js";

it("executes the Codex hook command with quoted arguments and JSON stdin in the native shell", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "oar hook ' test "));
  try {
    const script = path.join(home, "hook.cjs");
    await writeFile(script, "let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>console.log(JSON.stringify({arg:process.argv[2],input:JSON.parse(s)})));");
    const command = directoryHookCommand("codex", [process.execPath, script, "hook ' value"]);
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    const result = spawnSync(shell, args, { input: '{"text":"B_mcpafter"}', encoding: "utf8", timeout: 20_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ arg: "hook ' value", input: { text: "B_mcpafter" } });
    if (process.platform === "win32") {
      const old = spawnSync(shell, [...args.slice(0, -1), `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} --version`], { encoding: "utf8", timeout: 20_000 });
      expect(old.status).toBe(1);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
}, 45_000);
