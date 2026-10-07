import { expect, test } from "vitest";
import { grokInitializeMeta, grokSession } from "../../packages/oar/src/runtimes/grok/session.js";

const unavailable = { kind: "available", via: "executable", command: "oar-must-not-spawn" } as const;

test.each([undefined, "saved-session"])("both instructions reach one override, resume=%s", (resume) => {
  expect(grokInitializeMeta({ cwd: "/", ...(resume === undefined ? {} : { resume }), systemPrompt: "base", appendSystemPrompt: "extra" })).toMatchInlineSnapshot(`
    {
      "clientIdentifier": "oar",
      "clientType": "generic",
      "startupHints": {
        "nonInteractive": true,
        "skipGitStatus": true,
        "skipProjectLayout": true,
      },
      "systemPromptOverride": "base

    extra",
    }
  `);
});

test("append alone is refused before launch on resume, naming the unsupported option", async () => {
  await expect(grokSession(unavailable, { cwd: "/", resume: "saved-session", appendSystemPrompt: "extra" }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "appendSystemPrompt", message: "grok does not reapply rules when resuming a session (observed on 1.0.46)" });
});

test("individual new-session instruction channels stay distinct", () => {
  expect(grokInitializeMeta({ cwd: "/", systemPrompt: "base" })).toHaveProperty("systemPromptOverride", "base");
  expect(grokInitializeMeta({ cwd: "/", appendSystemPrompt: "extra" })).toHaveProperty("rules", "extra");
  expect(grokInitializeMeta({ cwd: "/", resume: "saved-session", systemPrompt: "replacement" })).toHaveProperty("systemPromptOverride", "replacement");
});
