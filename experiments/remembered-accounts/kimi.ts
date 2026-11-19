/** Linux: query the native profile after an accepted or rejected synthetic refresh. */
import assert from "node:assert/strict";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { kimiWebRequest } from "../../packages/oar/src/runtimes/kimi/web-query.js";
import { startKimiWeb } from "../../packages/oar/src/runtimes/kimi/web-startup.js";
import { stopKimiWeb } from "../../packages/oar/src/runtimes/kimi/web-shutdown.js";
import { kimiExpiredUsageFixture } from "../../sea-trial/vendor/support/kimi-expired-usage.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined);
async function identity(bin: string, mode: "success" | "rejected"): Promise<void> {
  const fixture = await kimiExpiredUsageFixture(mode);
  const signal = AbortSignal.timeout(30_000);
  try {
    const { child, web } = await startKimiWeb(bin, sessionEnvironment(fixture.env), signal);
    try {
      const usage = await kimiWebRequest(web, signal, "/oauth/usage");
      const profile = await kimiWebRequest(web, signal, "/oauth/userinfo");
      const info = asRecord(profile.userInfo);
      const hasEmail = typeof info?.email === "string";
      const hasName = typeof info?.nickname === "string";
      const expected = mode === "success" ? "ok" : "error";
      assert.equal(usage.kind, expected);
      assert.equal(profile.kind, expected);
      assert.equal(hasEmail, false);
      assert.equal(hasName, mode === "success");
      console.log(JSON.stringify({ mode, usage: usage.kind, profile: profile.kind, hasEmail, hasName }));
    } finally { await stopKimiWeb(child, web); }
  } finally { await fixture.dispose(); }
}
await identity(command, "success");
await identity(command, "rejected");
