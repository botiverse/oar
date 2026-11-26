import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { antigravityRuntime } from "../packages/oar/src/runtimes/antigravity/index.js";
import { dshRuntime } from "../packages/oar/src/runtimes/dsh/index.js";
import { createPiRuntime } from "../packages/oar/src/runtimes/pi/index.js";
import { codexRuntime } from "../packages/oar/src/runtimes/codex/index.js";
import { fakeAgentBinary } from "./fixtures/process-tree.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) { rmSync(directory, { recursive: true, force: true }); } });

/** A version-only executable: any actual reader process is an observable mistake. */
function executable(version: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-reader-floor-"));
  directories.push(directory);
  const calls = path.join(directory, "calls.jsonl");
  const script = path.join(directory, "version-only.mjs");
  writeFileSync(script, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `if (process.argv.at(-1) !== "--version") { throw new Error("reader must not launch"); }`,
    `process.stdout.write(${JSON.stringify(version)});`,
  ].join("\n"));
  return { directory, script, command: fakeAgentBinary(directory, [script]),
    calls: (): unknown[] => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line): unknown => JSON.parse(line)) : [] };
}

test.each(["1.2.7", "1.4.9", "1.5.0-beta.1", "unreadable"])("direct Antigravity readers refuse %s without launching any query", async (version) => {
  const fake = executable(version);
  const installation = { kind: "available", via: "executable", command: fake.command, version } as const;
  const versions = { ...(version === "unreadable" ? {} : { installedVersion: version }), requiredVersion: antigravityRuntime.minVersion };
  await expect(antigravityRuntime.listModels(installation)).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported", ...versions });
  await expect(antigravityRuntime.authStatus(installation)).resolves.toMatchObject({ kind: "unknown", code: "version_unsupported", ...versions });
  await expect(antigravityRuntime.accountUsage(installation)).resolves.toEqual({ kind: "unsupported", reason: "print_mode_disabled" });
  await expect(antigravityRuntime.accountUsage(installation, { allowPrintMode: true })).resolves.toEqual({ kind: "unsupported", reason: "version_unsupported", ...versions });
  expect(fake.calls()).toEqual([]);
});

test.each(["1.2.7", "ambiguous output"])("versionless Antigravity installations only run --version before refusing: %s", async (reported) => {
  const fake = executable(reported);
  const installation = { kind: "available", via: "executable", command: fake.command } as const;
  const [models, status, usage] = await Promise.all([
    antigravityRuntime.listModels(installation), antigravityRuntime.authStatus(installation), antigravityRuntime.accountUsage(installation, { allowPrintMode: true }),
  ]);
  expect([models, status]).toMatchObject([
    { kind: "unsupported", code: "version_unsupported", requiredVersion: "1.5.0" },
    { kind: "unknown", code: "version_unsupported", requiredVersion: "1.5.0" },
  ]);
  expect(usage).toMatchObject({ kind: "unsupported", reason: "version_unsupported", requiredVersion: "1.5.0" });
  for (const result of [models, status, usage]) {
    if (reported === "1.2.7") { expect(result).toHaveProperty("installedVersion", reported); }
    else { expect(result).not.toHaveProperty("installedVersion"); }
  }
  expect(fake.calls()).toEqual([["--version"], ["--version"], ["--version"]]);
});

test("versionless Antigravity accountUsage refuses without spawning when allowPrintMode is omitted", async () => {
  const fake = executable("1.2.7");
  expect(await antigravityRuntime.accountUsage({ kind: "available", via: "executable", command: fake.command })).toEqual({ kind: "unsupported", reason: "print_mode_disabled" });
  expect(fake.calls()).toEqual([]);
});

test.each([true, false])("direct DSH model reader keeps prerelease refusal and avoids bridge startup (version supplied: %s)", async (supplied) => {
  const version = "0.2.1-rc.4";
  const fake = executable(version);
  const result = await dshRuntime.listModels({ kind: "available", via: "executable", command: fake.command, ...(supplied ? { version } : {}) });
  expect(result).toMatchObject({ kind: "unsupported", code: "version_unsupported", installedVersion: version, requiredVersion: dshRuntime.minVersion });
  expect(fake.calls()).toEqual(supplied ? [] : [["--version"]]);
});

test.each(["listModels", "skills", "commands"] as const)("direct Pi RPC %s retains version refusal before a reader process starts", async (reader) => {
  const fake = executable("1.3.99");
  const runtime = createPiRuntime({ execution: "subprocess", command: process.execPath, args: [fake.script] });
  const result = await runtime[reader]({ kind: "available", via: "bundled" }, {
    cwd: fake.directory, env: { OAR_READER_FLOOR_CONTROL: fake.directory },
  });
  expect(result).toMatchObject({ kind: "unsupported", code: "version_unsupported", installedVersion: "1.3.99", requiredVersion: runtime.minVersion });
  expect(fake.calls()).toEqual([["--version"]]);
});

test("minimum-version metadata survives placement selection and does not claim SDK or login-only floors", () => {
  expect(antigravityRuntime.withPlacement("isolated").minVersion).toBe("1.5.0");
  expect(dshRuntime.minVersion).toBe("0.2.1-rc.5");
  expect(createPiRuntime({ execution: "subprocess" }).minVersion).toBe("1.4.0");
  expect(createPiRuntime()).not.toHaveProperty("minVersion");
  expect(codexRuntime).not.toHaveProperty("minVersion");
});


test("a failed Antigravity version command is unknown authentication, not a login or version refusal", async () => {
  const fake = executable("1.5.0");
  const result = await antigravityRuntime.authStatus({ kind: "available", via: "executable", command: path.join(fake.directory, "missing-command") });
  expect(result).toEqual({ kind: "unknown", detail: "Antigravity authentication status could not be read" });
  expect(fake.calls()).toEqual([]);
});
