import { expect, test } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/index.js";
import { opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const cwd = process.cwd();
const options = { cwd, resume: "fake-session", fork: {}, env: { FAKE_ACP_SESSION_CWD: cwd } };
const open = acpSession({ ...opencodeV2AcpProfile, args: [fixture, "opencode"] });

test("a fork binds the new id and records the fork response on the copy", async () => {
  const session = await open(installation, options);
  try {
    expect(session.id).toBe("forked-session");
    const fork = session.records().find(record => record.kind === "frame" && record.body.type === "session/fork");
    expect(fork).toMatchObject({ sessionId: session.id, body: { native: { sessionId: session.id } } });
  } finally { await session.dispose(); }
});

test.each(["", "fake-session"])("a fork refuses an invalid copy id %j", async id => {
  await expect(open(installation, { ...options, env: { ...options.env, FAKE_ACP_COPY_ID: id } })).rejects.toThrow(/session\/fork returned (?:no|the source) session id/u);
});

test("whole-history forks require the native capability and refuse anchored cuts", async () => {
  const missing = acpSession({ ...opencodeV2AcpProfile, args: [fixture, "listed"] });
  await expect(missing(installation, options)).rejects.toMatchObject({ option: "fork" });
  await expect(open(installation, { ...options, fork: { through: "turn-id" } })).rejects.toMatchObject({ option: "fork", message: "ACP session/fork accepts only a whole session and cannot cut at fork.through" });
});

test("the OpenCode v1 adapter still refuses fork before launching ACP", async () => {
  await expect(opencodeRuntime.session({ ...installation, version: "1.19.6", command: "does-not-exist" }, options)).rejects.toMatchObject({ option: "fork" });
});
