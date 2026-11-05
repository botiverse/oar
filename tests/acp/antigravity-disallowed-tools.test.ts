import { expect, test } from "vitest";
import { antigravityAcpProfile, antigravitySession } from "../../packages/oar/src/runtimes/antigravity/session.js";

const cwd = "/nonexistent";
const initialized = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };

test.each([undefined, "old-session"])("CLI tool denials fail before spawning on create/resume %s", async (resume) => {
  for (const disallowedTools of [["run_command"], ["read_file"], ["mcp__probe__echo"], ["run_command", "unknown"]]) {
    const opening = antigravitySession({ kind: "available", via: "executable", command: "/nonexistent" }, {
      cwd, disallowedTools, ...(resume === undefined ? {} : { resume }),
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- Check each requested restriction independently.
    await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  }
  expect(() => antigravityAcpProfile.validateOptions?.({ cwd, disallowedTools: [] })).not.toThrow();
});

test.each([undefined, "old-session"])("append uses the native namespace, without ignored tool metadata, on create/resume %s", (resume) => {
  const options = { cwd, appendSystemPrompt: "Keep the native harness.", ...(resume === undefined ? {} : { resume }) };
  expect(antigravityAcpProfile.sessionMeta?.(options, initialized)).toEqual({
    antigravity: { systemPrompt: { append: "Keep the native harness." } },
  });
  expect(antigravityAcpProfile.sessionMeta?.({ cwd, appendSystemPrompt: "" }, initialized)).toEqual({
    antigravity: { systemPrompt: { append: "" } },
  });
  expect(antigravityAcpProfile.sessionMeta?.({ cwd, disallowedTools: [] }, {})).toBeUndefined();
});

test("append is refused when initialize does not advertise the native channel", () => {
  expect(() => antigravityAcpProfile.sessionMeta?.({ cwd, appendSystemPrompt: "x" }, {})).toThrow("does not advertise systemPrompt.append");
});
