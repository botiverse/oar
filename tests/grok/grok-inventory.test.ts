import { expect, test } from "vitest";
import { projectGrokSkills } from "../../packages/oar/src/runtimes/grok/inventory.js";

test("Grok preserves native bundled source and path alongside legacy string sources", () => {
  expect(projectGrokSkills({ skills: [
    { name: "pptx", source: { type: "bundled", path: "/fixture/.grok/bundled/skills/pptx/SKILL.md" } },
    { name: "project", source: { type: "project", path: "/fixture/.agents/skills/project/SKILL.md" } },
    { name: "legacy", source: "user" },
    { name: "unknown" },
  ] })).toMatchInlineSnapshot(`
    [
      {
        "name": "pptx",
        "path": "/fixture/.grok/bundled/skills/pptx/SKILL.md",
        "scope": "builtin",
        "source": "bundled",
      },
      {
        "name": "project",
        "path": "/fixture/.agents/skills/project/SKILL.md",
        "scope": "project",
        "source": "project",
      },
      {
        "name": "legacy",
        "scope": "user",
        "source": "user",
      },
      {
        "name": "unknown",
      },
    ]
  `);
});

test("Grok preserves explicit invocation booleans and leaves missing or malformed flags unknown", () => {
  expect(projectGrokSkills({ skills: [
    { name: "yes", userInvocable: true }, { name: "no", userInvocable: false },
    { name: "absent" }, { name: "invalid", userInvocable: "false" },
  ] })).toEqual([
    { name: "yes", userInvocable: true }, { name: "no", userInvocable: false },
    { name: "absent" }, { name: "invalid" },
  ]);
});
