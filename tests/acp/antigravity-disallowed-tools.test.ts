import { expect, test } from "vitest";
import { antigravityAcpProfile, antigravitySession, antigravityToolDenials } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture } from "../fixtures/acp-session-support.js";

const cwd = "/nonexistent";
const initialized = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };
test.each([undefined, "old-session"])("native built-in denylist uses the same meta on create/resume %s", (resume) => {
  const options = { cwd, disallowedTools: ["run_command", "view_file"], ...(resume === undefined ? {} : { resume }) };
  expect(() => { antigravityToolDenials(options); }).not.toThrow();
  expect(antigravityAcpProfile.sessionMeta?.(options, initialized)).toEqual({ antigravity: { disabledTools: ["run_command", "view_file"] } });
  expect(antigravityAcpProfile.sessionMeta?.({ cwd }, {})).toBeUndefined();
  expect(antigravityAcpProfile.sessionMeta?.({ cwd, disallowedTools: [] }, {})).toEqual({ antigravity: { disabledTools: [] } });
});

test("mixed supported and unsupported names fail before spawning, naming every unsupported entry", async () => {
  const opening = antigravitySession({ kind: "available", via: "executable", command: "/nonexistent" }, {
    cwd, resume: "old-session", disallowedTools: ["run_command", "mcp__probe__echo", "client_view_file", "RUN_COMMAND"],
  });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  await expect(opening).rejects.toThrow('["mcp__probe__echo","client_view_file","RUN_COMMAND"]');
});

test.each([undefined, "old-session"])("missing native namespace refuses a nonempty denylist on create/resume %s", async (resume) => {
  const open = acpSession({ ...antigravityAcpProfile, args: [fixture, "session"] });
  const opening = open({ kind: "available", via: "executable", command: process.execPath }, {
    cwd: process.cwd(), disallowedTools: ["run_command"], ...(resume === undefined ? {} : { resume }),
  });
  // Dispose even on regression, when an ignored restriction wrongly opens.
  const result = await opening.then(async (session) => { await session.dispose(); return null; }, (error: unknown) => error);
  expect(result).toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  expect(result).toHaveProperty("message", expect.stringContaining("1.4.0"));
});

test.each([undefined, "old-session"])("append and tool denials share the native namespace on create/resume %s", (resume) => {
  const options = { cwd, appendSystemPrompt: "Keep the native harness.", disallowedTools: ["run_command"], ...(resume === undefined ? {} : { resume }) };
  expect(antigravityAcpProfile.sessionMeta?.(options, initialized)).toEqual({
    antigravity: { systemPrompt: { append: "Keep the native harness." }, disabledTools: ["run_command"] },
  });
  expect(antigravityAcpProfile.sessionMeta?.({ cwd, appendSystemPrompt: "" }, initialized)).toEqual({
    antigravity: { systemPrompt: { append: "" } },
  });
});

test("append is refused when initialize does not advertise the native channel", () => {
  expect(() => antigravityAcpProfile.sessionMeta?.({ cwd, appendSystemPrompt: "x" }, {})).toThrow("does not advertise systemPrompt.append");
});
