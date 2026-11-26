import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

async function disposeLogged(detach: boolean, closeLog: string): Promise<Session> {
  const session = await acpSession({ ...antigravityAcpProfile, detachOnDispose: detach, args: [fixture, "antigravity"] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd(), env: { FAKE_ACP_CLOSE_LOG: closeLog } },
  );
  await session.dispose();
  return session;
}

test.each([false, true])("dispose sends the advertised session/close unless the profile detaches: detach %s", async (detach) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-acp-detach-"));
  const closeLog = path.join(dir, "close.txt");
  try {
    const session = await disposeLogged(detach, closeLog);
    if (detach) {
      assert.equal(existsSync(closeLog), false);
    } else {
      assert.equal(readFileSync(closeLog, "utf8"), `${session.id}\n`);
    }
    const last = session.records().at(-1);
    assert.ok(last?.kind === "response" && last.body.kind === "exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
