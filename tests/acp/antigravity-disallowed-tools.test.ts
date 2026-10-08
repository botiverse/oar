import { expect, test } from "vitest";
import { antigravityAcpProfile, antigravitySession, antigravityToolDenials } from "../../packages/oar/src/runtimes/antigravity/session.js";

const cwd = "/nonexistent";
test.each([undefined, "old-session"])("native built-in denylist uses the same meta on create/resume %s", (resume) => {
  const options = { cwd, disallowedTools: ["run_command", "view_file"], ...(resume === undefined ? {} : { resume }) };
  expect(() => { antigravityToolDenials(options); }).not.toThrow();
  expect(antigravityAcpProfile.sessionMeta?.(options)).toEqual({ agy: { disabledTools: ["run_command", "view_file"] } });
  expect(antigravityAcpProfile.sessionMeta?.({ cwd })).toBeUndefined();
  expect(antigravityAcpProfile.sessionMeta?.({ cwd, disallowedTools: [] })).toEqual({ agy: { disabledTools: [] } });
});

test("mixed supported and unsupported names fail before spawning, naming every unsupported entry", async () => {
  const opening = antigravitySession({ kind: "available", via: "executable", command: "/nonexistent" }, {
    cwd, resume: "old-session", disallowedTools: ["run_command", "mcp__probe__echo", "client_view_file", "RUN_COMMAND"],
  });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  await expect(opening).rejects.toThrow('["mcp__probe__echo","client_view_file","RUN_COMMAND"]');
});
