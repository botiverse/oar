import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, promptAndWait, claudeRuntime } from "../../packages/oar/src/index.js";

import type { SessionOptions, UserConfigurationCategory } from "../../packages/oar/src/contracts/session.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { claudeConfigurationFixture } from "./support/user-configuration/claude-fixture.js";
import { ROTATED, TOKEN } from "./support/user-configuration/claude-oauth.js";

const claudeSession = claudeRuntime.session;

type Fixture = Awaited<ReturnType<typeof claudeConfigurationFixture>>;

async function observe(fixture: Fixture, command: string, configuration: SessionOptions["userConfiguration"], hostMcp = true, rotated = configuration === "exclude"): Promise<string> {
  const categories = typeof configuration === "object" ? configuration.exclude : [];
  const excluded = (category: UserConfigurationCategory): boolean => configuration === "exclude" || categories.includes(category);
  const settings = excluded("settings");
  const mcp = excluded("mcp");
  const instructions = excluded("instructions");
  const session = await claudeSession({ kind: "available", via: "executable", command }, {
    cwd: fixture.cwd, env: fixture.env, launchArgs: ["--debug-file", fixture.debugFile], ...(configuration === undefined ? {} : { userConfiguration: configuration }), mcpServers: hostMcp ? [fixture.host] : [],
  });
  try {
    const turn = await promptAndWait(session, "probe user configuration", { timeoutMs: 30_000 });
    expect(turn).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const init = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "system/init" ? [asRecord(record.body.native)] : []).at(-1);
    assert.ok(init);
    const catalog = JSON.stringify(init);
    const requests = JSON.stringify(fixture.model.requests.splice(0));
    for (const name of ["user-skill", "user-command", "user-agent", "plugin-skill"]) {
      expect(catalog.includes(name), name).toBe(!settings);
    }
    const servers = asRecordList(init.mcp_servers);
    for (const [name, scope, expected] of [
      ["user", "user", !settings && !mcp], ["local", "local", !mcp], ["project", "project", !mcp], ["host", "dynamic", hostMcp],
    ] as const) {
      const server = `${name}_config_probe`;
      expect(servers.some(entry => entry.name === server && entry.source === scope && entry.status === "connected"), scope).toBe(expected);
      expect(catalog.includes(`mcp__${server}__${name === "host" ? "echo" : `${name}_tool`}`), scope).toBe(expected);
    }
    for (const marker of ["USER_MEMORY", "HOME_MEMORY", "HOME_LOCAL_MEMORY", "USER_RULE"]) {
      expect(requests.includes(`OAR_${marker}_MARKER`), marker).toBe(!instructions);
    }
    // This fixture selects its auto-memory directory in user settings.
    expect(requests.includes("OAR_AUTO_MEMORY_MARKER")).toBe(!instructions && !settings);
    expect(requests).toContain("OAR_PROJECT_MEMORY_MARKER");
    expect(existsSync(path.join(fixture.home, "user-hook"))).toBe(!settings);
    expect(existsSync(path.join(fixture.home, "plugin-hook"))).toBe(!settings);
    expect(existsSync(path.join(fixture.home, "project-hook"))).toBe(true);
    const auth = fixture.model.auth.splice(0);
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((entry) => rotated ? entry.rotated : entry.original), JSON.stringify({ configuration, auth, oauth: fixture.oauth.seen, storage: await fixture.diagnostics() })).toBe(true);
    return session.id;
  } finally { await session.dispose(); await fixture.clearHooks(); }
}

async function resumeAcrossModes(fixture: Fixture, command: string, resume: string): Promise<void> {
  for (const userConfiguration of ["exclude", "include"] as const) {
    // oxlint-disable-next-line no-await-in-loop -- the same native history is resumed in both modes in sequence.
    const session = await claudeSession({ kind: "available", via: "executable", command }, {
      cwd: fixture.cwd, env: fixture.env, resume, userConfiguration, mcpServers: [fixture.host],
    });
    try {
      // oxlint-disable-next-line no-await-in-loop -- a completed turn confirms the native continuation before the next mode.
      expect(await promptAndWait(session, "resume configuration probe", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(session.id).toBe(resume);
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- close the old native reader before opening the same history again.
      await session.dispose();
    }
  }
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude excludes user configuration while retaining native credentials", () => {
  test("each category combination preserves its native MCP scopes, user settings and instructions", async () => {
    const installation = await claudeInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    const fixture = await claudeConfigurationFixture(installation.command);
    const cases = [[], ["settings"], ["mcp"], ["instructions"], ["settings", "mcp"], ["settings", "instructions"],
      ["mcp", "instructions"], ["instructions", "mcp", "settings"]] as const;
    try {
      for (const exclude of cases) {
        // oxlint-disable-next-line no-await-in-loop -- each run consumes and clears the same native fixture markers.
        await observe(fixture, installation.command, { exclude });
      }
    } finally { await fixture.close(); }
  }, 180_000);

  test.each(["fast", "default"])("%s tier and user-memory exclusion apply together", async (serviceTier) => {
    const installation = await claudeInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    const fixture = await claudeConfigurationFixture(installation.command);
    try {
      const session = await claudeSession(installation, {
        cwd: fixture.cwd, env: { ...fixture.env, ANTHROPIC_API_KEY: "fixture-only-not-a-secret" },
        model: "opus", serviceTier, userConfiguration: "exclude",
      });
      try {
        expect(await promptAndWait(session, "probe tier and memory", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
        expect(session.serviceTier().value).toBe(serviceTier);
        const init = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "system/init" ? [asRecord(record.body.native)] : []).at(-1);
        expect(init?.fast_mode_state).toBe(serviceTier === "fast" ? "on" : "off");
        const requests = JSON.stringify(fixture.model.requests);
        for (const marker of ["USER_MEMORY", "HOME_MEMORY", "HOME_LOCAL_MEMORY", "USER_RULE", "AUTO_MEMORY"]) {
          expect(requests, marker).not.toContain(`OAR_${marker}_MARKER`);
        }
        expect(requests).toContain("OAR_PROJECT_MEMORY_MARKER");
      } finally { await session.dispose(); }
    } finally { await fixture.close(); }
  }, 60_000);

  test.each([false, true])("configuration exclusion=%s retains native refresh and reuses it", async (exclude) => {
    const installation = await claudeInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    const fixture = await claudeConfigurationFixture(installation.command);
    try {
      expect(await fixture.status()).toMatchObject({ loggedIn: true, authMethod: "claude.ai" });
      const id = await observe(fixture, installation.command, "include");
      await fixture.expire();
      await observe(fixture, installation.command, exclude ? "exclude" : "include", true, true);
      expect(fixture.oauth.seen).toMatchObject({ exchanges: 1, verified: true });
      const credential = await fixture.readCredentials();
      expect(credential).toMatchObject({ claudeAiOauth: { accessToken: TOKEN, refreshToken: ROTATED } });
      await observe(fixture, installation.command, exclude ? "exclude" : "include", false, true);
      expect(fixture.oauth.seen.exchanges).toBe(1);
      expect(await fixture.status()).toMatchObject({ loggedIn: true, authMethod: "claude.ai" });
      expect(existsSync(fixture.credentials)).toBe(true);
      await resumeAcrossModes(fixture, installation.command, id);
    } finally { await fixture.close(); }
  }, 120_000);
});
