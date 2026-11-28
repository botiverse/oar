/* oxlint-disable eslint/max-statements -- Each test creates one failing or invalid-timeout fixture and checks rejection and redaction. */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { bottegaRuntime } from "../packages/oar/src/runtimes/bottega/index.js";
import { opencodeRuntime } from "../packages/oar/src/runtimes/opencode/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

async function writeFailingBinary(name: string): Promise<{ readonly dir: string; readonly command: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), `oar-${name}-lm-`));
  tempDirs.push(dir);
  const script = path.join(dir, `${name}.mjs`);
  await writeFile(script, 'process.stderr.write("fatal key=" + (process.env.OPENROUTER_API_KEY ?? "") + "\\n"); process.exit(1);\n', "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(dir, `${name}.cmd`);
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return { dir, command: cmd };
  }
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(bin, 0o755);
  return { dir, command: bin };
}

test("bottega listModels rejects invalid timeoutMs with RangeError and redacts options.env secrets from stderr", async () => {
  const { dir, command } = await writeFailingBinary("bottega");
  const installation = { kind: "available", via: "executable", command } as const;
  await expect(bottegaRuntime.listModels(installation, { cwd: dir, timeoutMs: -1 })).rejects.toBeInstanceOf(RangeError);
  await expect(bottegaRuntime.listModels(installation, { cwd: dir, timeoutMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);

  const canary = "sk-secret-bottega-list-models-987654321";
  const failed = await bottegaRuntime.listModels(installation, { cwd: dir, env: { OPENROUTER_API_KEY: canary } });
  expect(failed.kind).toBe("unsupported");
  expect(JSON.stringify(failed)).not.toContain(canary);
  expect(JSON.stringify(failed)).toContain("[redacted]");
});

test("opencode v1 listModels redacts options.env secrets from thrown processFailure message and cause", async () => {
  const { dir, command } = await writeFailingBinary("opencode");
  const canary = "sk-secret-opencode-list-models-987654321";
  let caught: unknown = undefined;
  try {
    await opencodeRuntime.listModels(
      { kind: "available", via: "executable", command, version: "1.18.30" },
      { cwd: dir, timeoutMs: 5000, env: { OPENROUTER_API_KEY: canary } },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = caught instanceof Error ? caught.message : String(caught);
  const cause = caught instanceof Error ? JSON.stringify(caught.cause ?? null) : "";
  expect(message).not.toContain(canary);
  expect(cause).not.toContain(canary);
  expect(message).toContain("[redacted]");
  expect(cause).toContain("[redacted]");
});
