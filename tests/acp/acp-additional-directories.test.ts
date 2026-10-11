import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { profile } from "../fixtures/acp-session-support.js";

// oxlint-disable-next-line eslint/max-statements -- One refused open followed by the advertised wire path.
test.each([undefined, "previous"])("ACP sends directory roots only after capability advertisement, resume=%s", async (resume) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-acp-directory-test-"));
  const log = path.join(cwd, "opens.jsonl");
  const installation = { kind: "available", via: "executable", command: process.execPath } as const;
  const options = { cwd, additionalDirectories: ["../extra directory"], ...(resume === undefined ? {} : { resume }), env: { FAKE_ACP_DIRECTORIES_LOG: log } };
  const start = acpSession(profile());
  try {
    await expect(start(installation, options)).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "additionalDirectories" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const session = await start(installation, { ...options, env: { ...options.env, FAKE_ACP_DIRECTORIES: "1" } });
    await session.dispose();
    const text = await readFile(log, "utf8");
    const raw: unknown = JSON.parse(text.trim());
    expect(raw).toEqual({ method: resume === undefined ? "session/new" : "session/resume", additionalDirectories: [path.resolve(cwd, "../extra directory")] });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
