/**
 * Runtime.install() against the real vendor installers, inside a sandbox:
 * per runtime, installPlan(), install(), the installation probe, install()
 * again (already_installed), checkUpdate() on the installed copy, and what
 * the runtime's own updater says about how the copy was installed (claude's
 * recorded installMethod, codex doctor's update action, grok's installer,
 * what `kimi upgrade -y` and `opencode upgrade` say at the latest release),
 * which shows it recognizes the copy.
 * Downloads each runtime; no login, no tokens. The `unsupported` answers
 * come from the environment: an install location variable naming a root-owned
 * directory (KIMI_INSTALL_DIR=/opt/kimi-code) or a PATH without curl.
 *
 * It installs into $HOME, so it refuses to run without
 * OAR_INSTALL_EXPERIMENT=sandbox. Run it in an empty, writable HOME with the
 * rest of the system read only, and a PATH without the host's own runtimes:
 *
 *   bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
 *     --tmpfs "$HOME" --setenv HOME "$HOME" --ro-bind "$PWD" "$PWD" \
 *     --setenv PATH /usr/bin:/bin --setenv TMPDIR /tmp \
 *     --setenv OAR_INSTALL_EXPERIMENT sandbox \
 *     --unshare-pid --die-with-parent --chdir "$PWD" -- \
 *     "$(command -v node)" node_modules/tsx/dist/cli.mjs \
 *     experiments/runtime-install.ts [runtime[@line]...] > install.json
 *
 * Each runtime of several release lines (opencode@v1, opencode@v2) needs its
 * own fresh HOME: the second install asks for the other line and must answer
 * already_installed with the first line.
 *
 * Findings: docs/runtimes/install.md.
 */
/* oxlint-disable eslint/no-await-in-loop -- one runtime at a time: the installers share the network and the sandbox HOME. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { defaultRuntimes } from "../packages/oar/src/index.js";

if (process.env.OAR_INSTALL_EXPERIMENT !== "sandbox") {
  process.stderr.write("refusing to install into this HOME: run inside a sandbox with OAR_INSTALL_EXPERIMENT=sandbox (see the header)\n");
  process.exit(2);
}

const OUTPUT_TAIL = 1500;

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
}

/** The command's stdout, or its stdout and stderr, without color codes; the exit status aside: the words are the evidence. */
function stdoutOf(command: string, args: readonly string[], withStderr = false): string {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return stripVTControlCharacters(`${result.stdout}${withStderr ? result.stderr : ""}`);
}

function linesAbout(text: string, pattern: RegExp): readonly string[] {
  return text.split("\n").filter((line) => pattern.test(line)).map((line) => line.trim());
}

function field(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = typeof current === "object" && current !== null ? Object.fromEntries(Object.entries(current))[key] : undefined;
  }
  return current;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** How the runtime's own updater sees the copy, in its own words. */
const vendorWords: Readonly<Record<string, (command: string) => unknown>> = {
  claude: () => {
    const config = readFileSync(path.join(homedir(), ".claude.json"), "utf8");
    return { installMethod: field(json(config), "installMethod") };
  },
  codex: (command) => ({ updateAction: field(json(stdoutOf(command, ["doctor", "--json"])), "checks", "updates.status", "details", "update action") }),
  grok: (command) => {
    const report = json(stdoutOf(command, ["update", "--check", "--json"]));
    return { installer: field(report, "installer"), channel: field(report, "channel") };
  },
  // kimi and opencode have no check-only mode: at the latest release their updater says how it sees the copy and does nothing.
  kimi: (command) => ({ upgrade: linesAbout(stdoutOf(command, ["upgrade", "-y"], true), /\S/u) }),
  opencode: (command) => ({ upgrade: linesAbout(stdoutOf(command, ["upgrade"], true), /method|skipped|upgraded/iu) }),
};

// `opencode@v2` installs that release line; a runtime with lines named without one shows `line_required`.
const wanted = new Map(process.argv.slice(2).map((arg) => {
  const [id = "", line] = arg.split("@");
  return [id, line] as const;
}));
const runtimes = defaultRuntimes.list().filter((runtime) => runtime.install !== undefined && (wanted.size === 0 || wanted.has(runtime.id)));
const reports: unknown[] = [];

for (const runtime of runtimes) {
  const line = wanted.get(runtime.id);
  const options = line === undefined ? {} : { line };
  // The second install asks for another line where there are lines: it must find the first, never replace it.
  const otherLine = runtime.installLines?.find((entry) => entry.line !== line)?.line;
  const started = Date.now();
  const plan = await runtime.installPlan?.(options);
  const install = await runtime.install?.({ ...options, timeoutMs: 600_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  const installation = await runtime.installation?.();
  const again = await runtime.install?.(otherLine === undefined ? {} : { line: otherLine });
  const check = installation?.kind === "available" ? await runtime.checkUpdate?.(installation) : undefined;
  const words = installation?.kind === "available" && installation.via === "executable" ? vendorWords[runtime.id]?.(installation.command) : undefined;
  reports.push({
    runtime: runtime.id,
    line,
    plan,
    install: install !== undefined && "output" in install ? { ...install, output: tail(install.output) } : install,
    seconds,
    installation,
    again: again === undefined ? undefined : { asked: otherLine, kind: again.kind, ...("line" in again ? { line: again.line } : {}) },
    check,
    vendorSays: words,
  });
  process.stderr.write(`${runtime.id}: ${install?.kind ?? "no install"} in ${String(seconds)} s\n`);
}

process.stdout.write(`${JSON.stringify({ home: homedir(), platform: `${process.platform}-${process.arch}`, path: process.env.PATH, reports }, null, 2)}\n`);
