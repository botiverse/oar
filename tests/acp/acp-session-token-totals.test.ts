import assert from "node:assert/strict";
import { test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import type { AcpSessionProfile } from "../../packages/oar/src/shared/acp/profile.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

// #161: kimi, opencode and antigravity report no token totals on their ACP
// surface (docs/runtimes/<id>.md), so `usage()` stays null over turns and no
// `cacheRead` / `cacheWrite` can appear. Each real profile runs against the
// fixture mode that replays its runtime, only the launch line swapped:
// "usage-after-response" kimi-code f9ca33376 (context-only usage_update after
// the answer), "opencode" opencode acp 1.18.30, "antigravity" agy_acp_server
// 1.2.1.
const nonReporting: readonly (readonly [string, AcpSessionProfile, string])[] = [
  ["kimi", kimiAcpProfile, "usage-after-response"],
  ["opencode", opencodeAcpProfile, "opencode"],
  ["antigravity", antigravityAcpProfile, "antigravity"],
];

async function startReplay(profile: AcpSessionProfile, mode: string): Promise<Session> {
  return acpSession({ ...profile, args: [fixture, mode] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd() },
  );
}

for (const [id, profile, mode] of nonReporting) {
  test(`${id} reports no token totals over two turns, so neither cache part`, async () => {
    const session = await startReplay(profile, mode);
    const first = await promptAndWait(session, "one");
    assert.equal(first.kind, "ended");
    const second = await promptAndWait(session, "two");
    assert.equal(second.kind, "ended");
    assert.deepEqual(session.usage().value, { total: null });
    const stamped = session.records().flatMap((record) => (record.kind === "frame" ? record.body.events : []))
      .filter((view) => view.kind === "usage" && view.usage.tokens !== undefined);
    assert.deepEqual(stamped, [], "no usage event carries tokens");
    await session.dispose();
  });
}
