import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { claudeInstallation } from "../../packages/oar/src/index.js";
import { activeRefresh, simultaneousRefresh } from "./support/orientation/shared-refresh.js";

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude native shared credential refresh", () => {
  test("auth status and a session coordinate one expired credential refresh", async () => {
    const installation = await claudeInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    await simultaneousRefresh(installation.command);
  }, 60_000);

  test("an active session rereads credentials refreshed by auth status after a 401", async () => {
    const installation = await claudeInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    await activeRefresh(installation.command);
  }, 60_000);
});
