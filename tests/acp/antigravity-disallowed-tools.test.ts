import { expect, test } from "vitest";
import { antigravityAcpProfile, antigravitySession, antigravityToolDenials } from "../../packages/oar/src/runtimes/antigravity/session.js";

const cwd = "/nonexistent";
test.each([undefined, "old-session"])("native built-in denylist uses the same meta on create/resume %s", (resume) => {
  const options = { cwd, disallowedTools: ["run_command", "view_file"], ...(resume === undefined ? {} : { resume }) };
  expect(() => { antigravityToolDenials(options); }).not.toThrow();
  expect(antigravityAcpProfile.sessionMeta?.(options, {})).toEqual({ antigravity: { disabledTools: ["run_command", "view_file"] } });
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

const initialized = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };

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
