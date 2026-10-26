import type { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveExecutable } from "../packages/oar/src/shared/executable/index.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userShellEnvironment } from "../packages/oar/src/shared/shell-environment.js";
import { build } from "esbuild";

const isSea = vi.hoisted(() => vi.fn(() => false));
vi.mock("node:sea", () => ({ isSea }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<{ spawn: typeof spawn }>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); isSea.mockReturnValue(false);
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

async function fixture(shell: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-capture-host-")); directories.push(dir);
  vi.stubEnv("HOME", dir); vi.stubEnv("ZDOTDIR", dir);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(dir, ".config"));
  vi.stubEnv("SHELL", shell); vi.stubEnv("ELECTRON_RUN_AS_NODE", undefined);
  return shellCaptureHost(dir);
}

// oxlint-disable-next-line max-lines-per-function -- Native cases share the unsupported-platform gate.
describe.skipIf(process.platform === "win32")("host-provided capture command", () => {
  for (const name of ["bash", "fish", "nu"]) {
    const shell = resolveExecutable(name);
    test.skipIf(shell === null)(`${name} passes command and arguments literally`, async () => {
      const command = await fixture(shell ?? name);
      const args = ["a space", "single' and double\"", String.raw`back\slash`, "", "-flag", "line\nbreak", "'##", "$(echo injected)", "`echo injected`", "; echo injected"];
      const before = { ...process.env };
      const result = await userShellEnvironment({ command, args: ["capture", ...args] });
      expect(JSON.parse(String(result.env.OAR_CAPTURE_ARGS))).toEqual(args);
      expect(result.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(result.env.OAR_CAPTURE_ELECTRON).toBe("absent");
      expect(JSON.stringify(process.env) === JSON.stringify(before)).toBe(true);
    });
  }

  test.each(["sea", "compiled-bun", "old-bun"])("a custom command works in a %s host without checking Node eligibility", async (host) => {
    const command = await fixture("/bin/bash");
    if (host === "sea") { isSea.mockReturnValue(true); }
    else { vi.stubGlobal("Bun", host === "compiled-bun" ? { isStandaloneExecutable: true } : {}); }
    isSea.mockClear();
    const result = await userShellEnvironment({ command, args: ["capture"] });
    expect(result.env.OAR_CAPTURE_ARGS).toBe("[]");
    expect(isSea).not.toHaveBeenCalled();
  });

  test("custom capture keeps profile changes, removals and the caller's Electron mode", async () => {
    const command = await fixture("/bin/bash");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "before"); vi.stubEnv("OAR_REMOVED", "before");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "caller-value");
    await writeFile(path.join(path.dirname(command), ".bash_profile"), "export CLAUDE_CONFIG_DIR=after\nunset OAR_REMOVED\n");
    const result = await userShellEnvironment({ command, args: ["capture"] });
    expect({
      directory: result.env.CLAUDE_CONFIG_DIR, removed: result.env.OAR_REMOVED,
      electron: result.env.ELECTRON_RUN_AS_NODE, childElectron: result.env.OAR_CAPTURE_ELECTRON,
    }).toMatchInlineSnapshot(`
      {
        "childElectron": "caller-value",
        "directory": "after",
        "electron": "caller-value",
        "removed": null,
      }
    `);
    expect(result.changedVariables).toContain("CLAUDE_CONFIG_DIR");
  });

  test.each([
    ["fail", "shell_failed"], ["incomplete", "invalid_output"], ["hang", "timed_out"],
  ])("%s uses the existing private failure boundary", async (mode, reason) => {
    const command = await fixture("/bin/bash");
    const failure: unknown = await userShellEnvironment({ command, args: [mode], timeoutMs: mode === "hang" ? 500 : 10_000 }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ name: "UserShellEnvironmentError", reason });
    expect(String(failure)).not.toContain("synthetic-secret");
    expect(failure).not.toHaveProperty("cause");
  });

  test("a missing command is a shell failure, without inspecting private diagnostics", async () => {
    const command = `${await fixture("/bin/bash")}-missing`;
    await expect(userShellEnvironment({ command, args: ["capture"] })).rejects.toMatchObject({ reason: "shell_failed" });
  });

  test("abort still bounds a custom capture process", async () => {
    const command = await fixture("/bin/bash");
    const controller = new AbortController();
    const pending = userShellEnvironment({ command, args: ["hang"], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  });
});

/** A single executable fixture whose subcommand uses the same public capture writer. */
async function shellCaptureHost(directory: string): Promise<string> {
  const command = path.join(directory, "capture host 'quoted.cjs");
  await build({
    stdin: {
      contents: `import { writeShellEnvironmentCapture } from "./packages/oar/src/shared/shell-environment-capture.js";
const [mode, ...args] = process.argv.slice(2);
const marker = args.pop();
if (mode === "fail") { process.stdout.write("synthetic-secret"); process.stderr.write("synthetic-secret"); process.exitCode = 7; }
else if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "incomplete") { process.stdout.write(marker + "{}"); }
else if (mode === "capture" && marker) {
  process.env.OAR_CAPTURE_ARGS = JSON.stringify(args);
  process.env.OAR_CAPTURE_ELECTRON = process.env.ELECTRON_RUN_AS_NODE ?? "absent";
  writeShellEnvironmentCapture(marker);
} else { process.exitCode = 9; }`,
      resolveDir: process.cwd(),
    },
    outfile: command, bundle: true, platform: "node", format: "cjs",
    banner: { js: `#!${process.execPath}` },
  });
  await chmod(command, 0o755);
  return command;
}
