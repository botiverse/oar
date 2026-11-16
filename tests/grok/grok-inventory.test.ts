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
        "source": "bundled",
      },
      {
        "name": "project",
        "path": "/fixture/.agents/skills/project/SKILL.md",
        "source": "project",
      },
      {
        "name": "legacy",
        "source": "user",
      },
      {
        "name": "unknown",
      },
    ]
  `);
});
