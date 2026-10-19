import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parseWindowsShim, runExecutable, runIsolated, spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { spawnLoginProcess } from "../../packages/oar/src/shared/login.js";

export function nodeShimText(script: string): string {
  return [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ") ELSE (", `  SET "_prog=node"`, ")", "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
  ].join("\r\n");
}
export const launchers = [
  {
    name: "spawnLineProcess",
    async run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
      const child = spawnLineProcess(command, args, { env });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const drained = once(child.stdout, "end");
      await child.spawned;
      await drained;
      expect(await child.exited).toBe(0);
      return output;
    },
  },
  {
    name: "runExecutable",
    async run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
      const result = await runExecutable(command, args, { env });
      expect(result.ok, result.stderr).toBe(true);
      return result.stdout;
    },
  },
  {
    name: "runIsolated",
    async run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
      const result = await runIsolated(command, args, { env, timeoutMs: 15_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timedOut).toBe(false);
      return result.stdout;
    },
  },
  {
    name: "spawnLoginProcess",
    async run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
      const lines: string[] = [];
      const child = spawnLoginProcess(command, args, env, { onLine(line, stream) { if (stream === "stdout") { lines.push(line); } } });
      child.closeInput();
      expect(await child.exited).toEqual({ exitCode: 0, signal: null });
      return lines.join("\n");
    },
  },
];

/** Absolute targets make this a genuine fallback, not an npm/pnpm shim. */
export function handwrittenShim(directory: string, extension: string, marker?: string): string {
  mkdirSync(directory, { recursive: true });
  const script = path.join(directory, "argv.cjs");
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  const command = path.join(directory, `argv.${extension}`);
  const started = marker === undefined ? "" : `echo STARTED > "${marker}"\r\n`;
  const text = `@echo off\r\n${started}"${process.execPath}" "${script}" %*\r\n`;
  writeFileSync(command, text);
  expect(parseWindowsShim(command, text, existsSync)).toBeNull();
  return command;
}

