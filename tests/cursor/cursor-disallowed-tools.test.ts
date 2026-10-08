import { expect, test } from "vitest";
import { cursorToolDenialError } from "../../packages/oar/src/runtimes/cursor/model.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";


test.each([undefined, "agent-old"])("native disallowedTools are passed unchanged on open/resume %s", async (resume) => {
  const disallowedTools = Object.freeze(["shell", "mcp"]);
  const { session, opened } = await openFakeCursor({ model: "composer", disallowedTools, ...(resume === undefined ? {} : { resume }) });
  expect(opened[0]?.options.disallowedTools).toEqual(disallowedTools);
  expect(opened[0]?.options.disallowedTools).not.toBe(disallowedTools);
  await session.dispose();
});


test("only native tool-name configuration failures become UnsupportedOptionError", () => {
  const error = new Error("Unknown tool name(s) in `disallowedTools`: mcp__server__tool");
  error.name = "ConfigurationError";
  expect(cursorToolDenialError(error, { cwd: "/tmp", disallowedTools: ["mcp__server__tool"] })).toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools", message: error.message });
  const other = new Error("network unavailable");
  expect(cursorToolDenialError(other, { cwd: "/tmp", disallowedTools: ["shell"] })).toBe(other);
});
