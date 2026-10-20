import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { claudeLogin } from "../../packages/oar/src/runtimes/claude/login.js";
import type { ExecutableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { fakeLoginCli, type FakeCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const CODE = "fixture-authorization-code#fixture-state";
const dir = mkdtempSync(path.join(tmpdir(), "oar-claude-browser-"));
let fakes = 0;
function fixture(): { fake: FakeCli; installation: ExecutableInstallation } {
  fakes += 1;
  const fake = fakeLoginCli({
    dir, name: `claude-${String(fakes)}`, script: "fake-claude-login.mjs",
    state: { version: "2.1.126", code: CODE, email: "user@example.com", loggedIn: false, mode: "paste" },
  });
  return { fake, installation: { kind: "available", via: "executable", command: fake.command, version: "2.1.126 (Claude Code)" } };
}
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

test.each([undefined, "inherited-browser"])("false overrides only the login child's browser (%s)", async (browser) => {
  vi.stubEnv("BROWSER", browser);
  const { fake, installation } = fixture();
  const interaction = recordedInteraction([CODE]);
  const result = await claudeLogin(installation, interaction, { openBrowser: false });
  assert.equal(result.kind, "logged_in");
  assert.equal(fake.read().browser, process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe")
    : "true");
  assert.equal(process.env.BROWSER, browser);
  assert.equal(interaction.events[0]?.kind, "auth_url");
  assert.deepEqual(fake.read().received, [CODE]);
});

test.each([
  { openBrowser: undefined, browser: undefined },
  { openBrowser: undefined, browser: "inherited-browser" },
  { openBrowser: true, browser: undefined },
  { openBrowser: true, browser: "inherited-browser" },
])("$openBrowser preserves the inherited browser environment ($browser)", async ({ openBrowser, browser }) => {
  vi.stubEnv("BROWSER", browser);
  const { fake, installation } = fixture();
  const options = openBrowser === undefined ? {} : { openBrowser };
  const result = await claudeLogin(installation, recordedInteraction([CODE]), options);
  assert.equal(result.kind, "logged_in");
  assert.equal(fake.read().browser, browser ?? null);
  assert.equal(process.env.BROWSER, browser);
});

test("false keeps the login version floor and refuses before spawning an older Claude", async () => {
  const { fake, installation } = fixture();
  const result = await claudeLogin({ ...installation, version: "2.1.125" }, recordedInteraction([]), { openBrowser: false });
  assert.equal(result.kind, "unsupported");
  assert.equal(result.reason, "version_unsupported");
  assert.equal(fake.read().loginStarted, undefined);
});
