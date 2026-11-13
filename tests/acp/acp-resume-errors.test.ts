/* oxlint-disable import/max-dependencies -- Covered ACP runtime profiles plus fixture/helper imports. */
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { devinAcpProfile } from "../../packages/oar/src/runtimes/devin/session.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const fixture = fileURLToPath(new URL("../fixtures/fake-acp-missing-resume.mjs", import.meta.url));
const listingFailures = [
  { name: "authentication", scenario: { pages: [{ error: { code: -32_000, message: "Authentication required" } }] }, expected: { name: "RuntimeFailureError", failure: "auth", cause: { method: "session/list", native: { code: -32_000 } } } },
  { name: "RPC error", scenario: { pages: [{ error: { code: -32_603, message: "listing unavailable" } }] }, expected: { code: -32_603, message: "listing unavailable", cause: { method: "session/list", native: { code: -32_603 } } } },
  { name: "process exit", scenario: { exitOnList: 17 }, expected: { name: "AcpError", kind: "process_exited", exitCode: 17 } },
];
for (const [name, native] of [["antigravity", antigravityAcpProfile], ["devin", devinAcpProfile], ["kimi", kimiAcpProfile], ["opencode", opencodeAcpProfile]] as const) {
  test.each(listingFailures)(`${name} preserves listing $name and never resumes`, async ({ scenario, expected }) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "oar-acp-cwd-list-error-"));
    const dir = realpathSync(temporary);
    const log = path.join(dir, "calls.txt");
    try {
      const opening = acpSession({ ...native, args: [fixture] })(installation, { cwd: dir, resume: "missing-session", env: {
        FAKE_RESUME_CASE: JSON.stringify({ succeed: true, ...scenario }), FAKE_ACP_CALL_LOG: log,
      } });
      const failure: unknown = await opening.then(async (session) => { await session.dispose(); return null; }, (error: unknown) => error);
      expect(failure).not.toBeInstanceOf(UnsupportedOptionError);
      expect(failure).toMatchObject(expected);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["initialize", "session/list"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

