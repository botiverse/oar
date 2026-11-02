import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { startDurableFixture } from "../harness/pi-durable.js";
import { runTurn } from "./support/asserts.js";

function answer(session: Session): string {
  return session.records().flatMap(record => record.kind === "frame" ? record.body.events : [])
    .filter(event => event.kind === "text_delta").map(event => event.text).join("");
}

test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock")("host-owned Durable and the bundled Pi SDK keep separate provider catalogs in one host", async () => {
  const sdk = await startPiAimock(mock => { mock.onMessage(/sdk input/u, { content: "SDK-ANSWER" }); });
  const durable = await startDurableFixture(mock => { mock.onMessage(/durable input/u, { content: "DURABLE-ANSWER" }); });
  let sdkSession: Session | undefined = undefined;
  let durableSession: Session | undefined = undefined;
  try {
    const runtime = createPiRuntime({ execution: "in-process" });
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available");
    const cwd = process.env.OAR_PI_AGENT_DIR;
    assert.ok(cwd !== undefined);
    sdkSession = await runtime.session(installation, { cwd, model: "aimock/aimock-model" });
    durableSession = await durable.runtime.session({ kind: "available", via: "bundled" }, { cwd, model: "aimock/aimock-model" });
    expect(await Promise.all([runTurn(sdkSession, "sdk input"), runTurn(durableSession, "durable input")]))
      .toEqual([{ kind: "completed" }, { kind: "completed" }]);
    expect(answer(sdkSession)).toBe("SDK-ANSWER");
    expect(answer(durableSession)).toBe("DURABLE-ANSWER");
    expect(sdk.mock.getRequests()).toHaveLength(1);
    expect(durable.mock.getRequests()).toHaveLength(1);
  } finally {
    await sdkSession?.dispose();
    await durableSession?.dispose();
    await durable.close();
    await sdk.stop();
  }
}, 30_000);
