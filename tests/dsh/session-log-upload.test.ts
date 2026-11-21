import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshRuntime, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-session-log-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const installation = { kind: "available", via: "executable", command, version: "0.2.2-rc.5" } as const;
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

test("DSH opens when sessionLogUpload is off and session-log-deepseek applies enabled: false", async () => {
  const session = await dshRuntime.session(installation, { cwd: dir, sessionLogUpload: "off" });
  await session.dispose();
});

test("DSH opens when sessionLogUpload is off and session-log-deepseek is already disabled", async () => {
  const session = await dshRuntime.session(installation, {
    cwd: dir,
    sessionLogUpload: "off",
    env: { FAKE_DSH_SESSION_LOG_DISABLED: "1" },
  });
  await session.dispose();
});

test("DSH refuses sessionLogUpload: 'off' when the plugin state cannot be confirmed", async () => {
  const cases: readonly Readonly<Record<string, string>>[] = [
    { FAKE_DSH_MODE: "no-loader-entries" },
    { FAKE_DSH_MISSING: "session-log-deepseek" },
    { FAKE_DSH_SESSION_LOG_NAME: "@deepseek-ai/other-plugin" },
    { FAKE_DSH_SESSION_LOG_IGNORE_PATCH: "1" },
    { FAKE_DSH_SESSION_LOG_STATE: "0" },
  ];
  for (const env of cases) {
    // oxlint-disable-next-line no-await-in-loop -- sequential opens keep each startup refusal isolated.
    const refused = await dshRuntime.session(installation, { cwd: dir, sessionLogUpload: "off", env }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnsupportedOptionError);
    expect(refused).toMatchObject({ option: "sessionLogUpload" });
  }
}, 30_000);

test("DSH refuses sessionLogUpload: 'off' before spawning on unverified versions below 0.2.1-rc.5", async () => {
  const old = { kind: "available", via: "executable", command: "/nonexistent/dsh", version: "0.2.1-rc.4" } as const;
  await expect(dshRuntime.session(old, { cwd: dir, sessionLogUpload: "off" }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "sessionLogUpload" });
});

test("DSH ignores missing session-log-deepseek when sessionLogUpload is omitted", async () => {
  const session = await dshRuntime.session(installation, {
    cwd: dir,
    env: { FAKE_DSH_MISSING: "session-log-deepseek" },
  });
  await session.dispose();
});
