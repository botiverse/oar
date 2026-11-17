import { isDeepStrictEqual } from "node:util";

// An issue is linked only for an observed version, test and assertion signature.
// This labels evidence; it never changes a test result or permits a version bump.
export const kimiIssue = "https://github.com/botiverse/oar/issues/899";
export const mcpCase = "kimi-aimock mcpServers > a stdio and an http server attach, the agent calls both, and a resume attaches them again";
export const workspaceCase = "Kimi native Web skill inventory > discovery preserves an existing user workspace with the same root";
const tools = ["mcp__echo__echo", "mcp__remote__echo"];
// Vitest pretty-prints objects with trailing commas. Preserve string contents.
function objectValue(value) {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value.replace(/,(?=\s*[}\]])/gu, "")); }
  catch { return undefined; }
}

export function knownCandidateFailure({ key, version, file, name, errors }) {
  if (!["2.6.2", "2.6.3"].includes(version) || errors?.length !== 1 || errors[0].name !== "AssertionError") return undefined;
  const error = errors[0];
  if (key === "kimi-aimock" && file === "sea-trial/vendor/mcp-servers-acp.vendor.test.ts" && name === mcpCase
    && isDeepStrictEqual(objectValue(error.expected), { opened: tools, resumedWithout: [] })
    && isDeepStrictEqual(objectValue(error.actual), { opened: tools, resumedWithout: tools })) {
    return { issue: kimiIssue, signature: "MCP tools retained on resume without servers" };
  }
  const workspaceId = /^wm_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
  if (key === "kimi-login" && file === "sea-trial/vendor/kimi-skills.vendor.test.ts" && name === workspaceCase
    && workspaceId.test(error.expected) && workspaceId.test(error.actual) && error.expected !== error.actual) {
    return { issue: kimiIssue, signature: "Different workspace ID for the same root" };
  }
}
