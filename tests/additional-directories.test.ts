import path from "node:path";
import { expect, test } from "vitest";
import { codexThreadOpen, codexOpenReadback } from "../packages/oar/src/runtimes/codex/open.js";
import { kimiSession } from "../packages/oar/src/runtimes/kimi/session.js";
import { opencodeSession } from "../packages/oar/src/runtimes/opencode/session.js";
import { resolvedAdditionalDirectories } from "../packages/oar/src/shared/additional-directories.js";
import { openFakeCursor } from "./fixtures/fake-cursor-sdk.js";

const cwd = path.resolve("project");
const extra = path.resolve(cwd, "../extra directory");

test("directory paths resolve against the session cwd, preserve spaces and deduplicate without mutating the host's list", () => {
  const directories = Object.freeze(["../extra directory", extra, "."]);
  expect(resolvedAdditionalDirectories({ cwd, additionalDirectories: directories })).toEqual([extra, cwd]);
  expect(directories).toEqual(["../extra directory", extra, "."]);
  expect(() => resolvedAdditionalDirectories({ cwd, additionalDirectories: [""] })).toThrow("non-empty paths");
});

test.each([undefined, "old-thread"])("codex sets and confirms workspace roots without changing permission config, resume=%s", (resume) => {
  const options = { cwd, additionalDirectories: ["../extra directory", "."], ...(resume === undefined ? {} : { resume }) };
  const { method, params } = codexThreadOpen(options);
  expect(params.runtimeWorkspaceRoots).toEqual([cwd, extra]);
  expect(params).not.toHaveProperty("config");
  expect(params).not.toHaveProperty("sandbox");
  expect(codexOpenReadback(method, options, { runtimeWorkspaceRoots: [cwd, extra] }).refusal).toBeNull();
  // A loaded native thread can ignore the override; never accept that reply.
  expect(codexOpenReadback(method, options, { runtimeWorkspaceRoots: [cwd] }).refusal).toContain("did not confirm");
  expect(codexOpenReadback(method, options, {}).refusal).toContain("did not confirm");
  expect(codexThreadOpen({ cwd, additionalDirectories: [] }).params).not.toHaveProperty("runtimeWorkspaceRoots");
});

test.each([undefined, "old-agent"])("Cursor gives its SDK additional roots while keeping cwd and sandbox, resume=%s", async (resume) => {
  const { session, opened } = await openFakeCursor({ additionalDirectories: ["../extra directory"], ...(resume === undefined ? {} : { resume }) });
  try {
    expect(opened[0]).toMatchObject({ how: resume === undefined ? "create" : "resume", options: { local: { cwd: "/w", dirs: [path.resolve("/w", "../extra directory")], sandboxOptions: { enabled: false } } } });
  } finally { await session.dispose(); }
});

test("Kimi refuses a directory override on resume before starting the runtime or looking up the id", async () => {
  const opening = kimiSession({ kind: "available", via: "executable", command: "/does-not-exist" }, { cwd, resume: "missing", additionalDirectories: [extra] });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "additionalDirectories" });
  await expect(opening).rejects.toThrow("no effect on resume");
});

test("OpenCode v1 refuses directories before preparing prompts or opening ACP", async () => {
  await expect(opencodeSession({ kind: "available", via: "executable", command: "/does-not-exist", version: "1.18.35" }, { cwd, additionalDirectories: [extra], systemPrompt: "replace" }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "additionalDirectories" });
});
