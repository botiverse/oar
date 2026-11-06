import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";
import observeFakeLogin from "../fixtures/login-process-observer.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }));
});
async function fixture(mode = "success") {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-login-diagnostics-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "kimi", script: "fake-kimi-login.mjs", state: { mode, loggedIn: false } });
  return { dir, fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "2.3.3" } };
}

test("retains stderr and exit when the fake fails before recording its first call", async () => {
  const { dir, fake, installation } = await fixture();
  const processes = await observeFakeLogin(fake.command);
  await writeFile(path.join(dir, "kimi.json"), "{");
  expect(await kimiRuntime.login(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
    {
      "detail": "Kimi login ended without reporting success",
      "kind": "failed",
      "reason": "process_failed",
    }
  `);
  expect(processes()).toMatchObject([{ kind: "login", args: ["login"], exit: { exitCode: 1, signal: null } }]);
  expect(JSON.stringify(processes())).toContain('"stream":"stderr","text":"SyntaxError');
});

test("keeps successful login and ACP confirmation unchanged while recording both processes", async () => {
  const { fake, installation } = await fixture();
  const processes = await observeFakeLogin(fake.command);
  expect(await kimiRuntime.login(installation, recordedInteraction([]))).toEqual({ kind: "logged_in" });
  expect(processes()).toMatchObject([
    { kind: "login", args: ["login"], exit: { exitCode: 0, signal: null } },
    { kind: "acp", args: ["acp"], diagnostics: { stderr: "private-token private@example.invalid\n" } },
  ]);
  expect(fake.read().calls).toEqual([["login"], ["acp"]]);
});

test("does not observe another executable", async () => {
  const { fake, installation } = await fixture();
  const processes = await observeFakeLogin(`${fake.command}-other`);
  expect(await kimiRuntime.login(installation, recordedInteraction([]))).toEqual({ kind: "logged_in" });
  expect(processes()).toEqual([]);
});

