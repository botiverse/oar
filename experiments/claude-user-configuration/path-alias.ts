/**
 * Native ancestor classification with an aliased HOME. No real login/provider.
 * Run: OAR_CLAUDE_BIN=/path/to/claude pnpm tsx experiments/claude-user-configuration/path-alias.ts
 * Observed 2026-10-23, Claude 2.1.309 on Linux: native exclusion flags still
 * load user memory, skills and agents as project content. OAR refuses first.
 */
import assert from "node:assert/strict";
import { symlink, rm } from "node:fs/promises";
import path from "node:path";
import { claudeInstallation, claudeSession, promptAndWait, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { claudeConfigurationFixture } from "../../sea-trial/vendor/support/user-configuration/claude-fixture.js";

const installation = await claudeInstallation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const fixture = await claudeConfigurationFixture(installation.command);
const alias = `${fixture.home}-alias`;
try {
  await symlink(fixture.home, alias, "junction");
  const config = path.join(alias, ".claude");
  const options = { cwd: fixture.cwd, env: { ...fixture.env, HOME: alias, USERPROFILE: alias, CLAUDE_CONFIG_DIR: config } };
  await assert.rejects(claudeSession(installation, { ...options, userConfiguration: "exclude" }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "userConfiguration");
  // Supply only the native flags under normal inclusion to observe the vendor
  // independently of OAR's pre-launch exclusion guard.
  const excluded = [path.join(config, "**"), path.join(alias, "CLAUDE.md"), path.join(alias, "CLAUDE.local.md")].map((value) => value.replaceAll("\\", "/"));
  const session = await claudeSession(installation, {
    ...options,
    env: { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    launchArgs: ["--setting-sources", "project,local", "--strict-mcp-config", "--settings", JSON.stringify({ claudeMdExcludes: excluded })],
  });
  try {
    assert.deepEqual(await promptAndWait(session, "probe alias", { timeoutMs: 30_000 }).then((turn) => turn.kind), "ended");
    const catalog = JSON.stringify(session.records().filter((record) => record.kind === "frame" && record.body.type === "system/init"));
    const requests = JSON.stringify(fixture.model.requests);
    console.log(JSON.stringify({
      oarRejectedBeforeLaunch: true,
      nativeUserMemoryLoaded: requests.includes("OAR_USER_MEMORY_MARKER"),
      nativeHomeMemoryLoaded: requests.includes("OAR_HOME_MEMORY_MARKER"),
      nativeProjectMemoryLoaded: requests.includes("OAR_PROJECT_MEMORY_MARKER"),
      nativeUserSkillLoaded: catalog.includes("user-skill"),
      nativeUserAgentLoaded: catalog.includes("user-agent"),
    }));
  } finally { await session.dispose(); }
} finally { await rm(alias, { force: true }); await fixture.close(); }
