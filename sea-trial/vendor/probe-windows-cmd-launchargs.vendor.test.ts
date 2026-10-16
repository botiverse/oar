import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { claudeInstallation, claudeRuntime, claudeSession, promptAndWait, type SessionOptions } from "../../packages/oar/src/index.js";
import type { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { startClaudeAimock } from "../harness/aimock.js";

/*
 * PROBE, NOT FOR MERGE (draft PR #409), second run: Windows argv forwarding
 * through an npm `.cmd` shim. Each value goes in as `--append-system-prompt`
 * (through launchArgs or SessionOptions.appendSystemPrompt); claude's provider
 * request shows what arrived. A canary value must leave no file behind. A
 * control runs the same values through cross-spawn and a `.cmd` that only
 * records its argv, without OAR. authStatus runs once through a `.cmd` in a
 * directory with a space.
 */

const spawned: { command: string; args: readonly string[] }[] = [];
vi.mock("../../packages/oar/src/shared/executable/index.js", async (importOriginal) => {
  const actual = await importOriginal<{ spawnLineProcess: typeof spawnLineProcess }>();
  return {
    ...actual,
    spawnLineProcess: (...args: Parameters<typeof actual.spawnLineProcess>) => {
      spawned.push({ command: args[0], args: args[1] });
      return actual.spawnLineProcess(...args);
    },
  };
});

const SINGLE = ["plain", "two words", 'say "hi" there', "100%PATH% and %%", "caret^here ^^ end^", "amp & pipe | lt < gt >",
  "bang! and !PATH!", "trailing backslash\\", "C:\\dir with space\\", "quote at end\"", "parens (x) and [y]", "unicode é中文"];
const COMBINED = SINGLE.join(" | ");
const temp = process.env.RUNNER_TEMP ?? tmpdir();
const canary = (n: number): string => path.join(temp, `lk-canary-${String(n)}.txt`);
const canaryValue = (n: number): string => `x" & echo LKCANARY>"${canary(n)}" & "`;
interface Case { readonly label: string; readonly value: string; readonly via: "launchArgs" | "appendSystemPrompt"; readonly canary?: number; readonly showArgs?: boolean }
const CASES: readonly Case[] = [
  { label: "combined", value: COMBINED, via: "appendSystemPrompt", showArgs: true },
  { label: "combined", value: COMBINED, via: "launchArgs", showArgs: true },
  { label: "odd quote then pipe", value: 'a" | b', via: "appendSystemPrompt" },
  { label: "odd quote then pipe", value: 'a" | b', via: "launchArgs" },
  { label: "odd quote then amp", value: 'a" & b', via: "appendSystemPrompt" },
  { label: "even quotes then pipe", value: 'say "hi" | x', via: "appendSystemPrompt" },
  { label: "three quotes then amp", value: 'a "b" c" & d', via: "appendSystemPrompt" },
  { label: "canary", value: canaryValue(1), via: "appendSystemPrompt", canary: 1 },
  { label: "canary", value: canaryValue(2), via: "launchArgs", canary: 2 },
];
const wrap = (value: string): string => `[[LK:${value}:LK]]`;
function systemHead(body: unknown): string {
  const text = JSON.stringify(body);
  const at = text.indexOf("[[LK:");
  return at === -1 ? "" : text.slice(at, at + 400);
}
function seen(body: unknown): string | null {
  const match = /\[\[LK:(.*?):LK\]\]/su.exec(JSON.stringify(body));
  if (match?.[1] === undefined) { return null; }
  const decoded: unknown = JSON.parse(`"${match[1]}"`);
  return typeof decoded === "string" ? decoded : null;
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

describe.skipIf(process.env.OAR_TEST !== "claude-aimock" || process.platform !== "win32")("probe: Windows .cmd argv forwarding", () => {
  test("argv-carried values reach claude unchanged and leave no canary", async () => {
    const installation = await claudeInstallation();
    if (installation.kind !== "available" || installation.via !== "executable") {
      throw new Error(`claude is ${installation.kind}`);
    }
    const lines: string[] = [`PROBE claude command: ${installation.command} (version ${installation.version ?? "?"})`];
    for (const item of CASES) {
      if (item.canary !== undefined) { rmSync(canary(item.canary), { force: true }); }
      const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, { captureRaw: true });
      const before = spawned.length;
      let outcome = "";
      try {
        const options: SessionOptions = {
          cwd: process.cwd(), ...(env.env === undefined ? {} : { env: env.env }),
          ...(item.via === "launchArgs" ? { launchArgs: ["--append-system-prompt", wrap(item.value)] } : { appendSystemPrompt: wrap(item.value) }),
        };
        const session = await claudeSession(installation, options);
        try {
          const turn = await promptAndWait(session, "probe", { timeoutMs: 60_000 });
          outcome = turn.kind === "rejected" ? `rejected ${turn.code}` : `${turn.kind}/${turn.outcome.kind}${turn.outcome.kind === "failed" ? ` reason=${JSON.stringify(turn.outcome.reason.slice(0, 200))}` : ""}`;
        } finally { await session.dispose(); }
      } catch (error) {
        outcome = `threw ${message(error)}`;
      } finally { await env.stop(); }
      const received = env.raw.map((request) => seen(request.body)).find((found) => found !== null) ?? null;
      const same = received === item.value;
      const head = same ? "" : ` systemHead=${env.raw.map((request) => systemHead(request.body)).find((found) => found !== "") ?? "(none)"}`;
      const file = item.canary === undefined ? "" : ` canaryFile=${String(existsSync(canary(item.canary)))}`;
      lines.push(`PROBE ${same ? "SAME" : "DIFF"} ${item.via} [${item.label}] requests=${String(env.raw.length)} outcome=${outcome}${file}${head}`);
      if (item.showArgs === true) {
        for (const call of spawned.slice(before)) { lines.push(`PROBE spawnLineProcess(${call.command}, ${JSON.stringify(call.args)})`); }
      }
    }
    // Control without OAR: cross-spawn launches a .cmd that only records its argv.
    const require = createRequire(path.join(import.meta.dirname, "..", "..", "packages", "oar", "package.json"));
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- probe: cross-spawn is packages/oar's own dependency, not the root's
    const crossSpawn = require("cross-spawn") as { sync: (command: string, args: readonly string[], options: object) => { status: number | null } };
    const dir = path.join(temp, "lk-echoargs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "echoargs.js"), "require('fs').writeFileSync(process.env.LK_ARGS_OUT, JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(path.join(dir, "echoargs.cmd"), `@"${process.execPath}" "%~dp0echoargs.js" %*\r\n`);
    for (const [label, value, n] of [["combined", COMBINED, 3], ["odd quote then pipe", 'a" | b', 4], ["canary", canaryValue(5), 5]] as const) {
      const out = path.join(dir, `out-${String(n)}.json`);
      rmSync(out, { force: true });
      rmSync(canary(5), { force: true });
      const result = crossSpawn.sync(path.join(dir, "echoargs.cmd"), [value], { env: { ...process.env, LK_ARGS_OUT: out } });
      const got = existsSync(out) ? readFileSync(out, "utf8") : "(no output)";
      const same = got === JSON.stringify([value]);
      const file = label === "canary" ? ` canaryFile=${String(existsSync(canary(5)))}` : "";
      lines.push(`PROBE control cross-spawn [${label}] status=${String(result.status)} same=${String(same)} argv=${got.slice(0, 400)}${file}`);
    }
    // runExecutable spawns .cmd/.bat with shell: true: a .cmd path with a space.
    const spaced = path.join(temp, "dir with space");
    mkdirSync(spaced, { recursive: true });
    const wrapper = path.join(spaced, "claude.cmd");
    writeFileSync(wrapper, `@"${installation.command}" %*\r\n`);
    try {
      const status = await claudeRuntime.authStatus({ kind: "available", via: "executable", command: wrapper });
      lines.push(`PROBE authStatus via "${wrapper}": ${JSON.stringify(status).slice(0, 300)}`);
    } catch (error) {
      lines.push(`PROBE authStatus via "${wrapper}": threw ${message(error)}`);
    }
    const plain = spawnSync(wrapper, ["--version"], { shell: true, encoding: "utf8" });
    const stdout = JSON.stringify(plain.stdout.trim()).slice(0, 80);
    const stderr = JSON.stringify(plain.stderr.trim()).slice(0, 160);
    lines.push(`PROBE node spawnSync(shell: true) "${wrapper}" --version: status=${String(plain.status)} stdout=${stdout} stderr=${stderr}`);
    for (const line of lines) { console.log(line); }
    expect(lines.filter((line) => line.includes("PROBE DIFF") || line.includes("canaryFile=true"))).toEqual([]);
  }, 900_000);
});
