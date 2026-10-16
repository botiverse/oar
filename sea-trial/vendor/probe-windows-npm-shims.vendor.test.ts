import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, codexInstallation } from "../../packages/oar/src/index.js";

/*
 * PROBE, NOT FOR MERGE (draft PR): print the npm shims CI installs on
 * Windows (`npm install -g` of claude and codex), so the shim parser can be
 * matched to their real contents. Prints only file contents and paths.
 */

const targetsOf = (dir: string, text: string): string[] => [...text.matchAll(/"%dp0%\\([^"]+)"/gu)].map((match) => path.join(dir, match[1] ?? ""));

describe.skipIf(process.platform !== "win32" || (process.env.OAR_TEST !== "claude-aimock" && process.env.OAR_TEST !== "codex-aimock"))("probe: Windows npm shims", () => {
  test("print the installed shims", async () => {
    const lines: string[] = [];
    const npm = spawnSync("npm", ["--version"], { shell: true, encoding: "utf8" });
    lines.push(`PROBE node ${process.version} npm ${npm.stdout.trim()}`);
    for (const probe of [claudeInstallation, codexInstallation]) {
      const installation = await probe();
      if (installation.kind !== "available" || installation.via !== "executable") {
        lines.push(`PROBE installation ${installation.kind}`);
        continue;
      }
      const shim = installation.command;
      const dir = path.dirname(shim);
      const listing = JSON.stringify(readdirSync(dir));
      const besideNode = existsSync(path.join(dir, "node.exe"));
      lines.push(`PROBE shim ${shim} version=${installation.version ?? "?"}`, `PROBE dir ${dir}: ${listing}`, `PROBE node.exe beside the shim: ${String(besideNode)}`);
      if (/\.(?:cmd|bat)$/iu.test(shim)) {
        const text = readFileSync(shim, "utf8");
        lines.push(`PROBE content-json ${JSON.stringify(text)}`);
        for (const line of text.split(/\r?\n/u)) { lines.push(`PROBE content| ${line}`); }
        for (const target of targetsOf(dir, text)) { lines.push(`PROBE target ${target} exists=${String(existsSync(target))}`); }
      }
    }
    for (const line of lines) { console.log(line); }
    expect(lines.length).toBeGreaterThan(0);
  });
});
