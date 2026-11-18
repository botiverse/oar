# Claude skill catalog: context list joined with initialize commands (2026-11-18)

Claude Code 2.1.322, Linux x64, `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence`, one process answering `initialize` then `get_context_usage {detail: "summary"}`. No prompt and no model request. HOME pointed at an isolated directory; the workspace was an empty temporary directory.

Fixture:
- project `.claude/commands/deploy.md` (`description: Deploy it`, `argument-hint: [env]`)
- project `.claude/skills/demo-skill/SKILL.md` (`description: A demo skill`)
- project `.claude/skills/hidden-skill/SKILL.md` (`disable-model-invocation: true`)
- user `~/.claude/commands/ucmd.md` (`description: User cmd`)
- user `~/.claude/skills/user-skill/SKILL.md` (`user-invocable: false`)

| Entry | `get_context_usage` skillFrontmatter | `initialize.commands` |
| --- | --- | --- |
| deploy | `source: projectSettings`, path `.claude/commands/deploy.md` | `description: "Deploy it (project)"`, `argumentHint: "env"` |
| demo-skill | `projectSettings`, path `.claude/skills/demo-skill/SKILL.md` | `"A demo skill (project)"` |
| hidden-skill | absent | `"Hidden one (project)"` |
| ucmd | `userSettings`, path `~/.claude/commands/ucmd.md` | `"User cmd (user)"` |
| user-skill | `userSettings`, path `~/.claude/skills/user-skill/SKILL.md` | absent |

Commands carry no source field; only `builtin: true` for built-ins. The trailing " (project)" / " (user)" is Claude's display label for file-backed entries. `get_context_usage` also reports `skills.totalSkills` and `includedSkills`, so the context list can omit skills for budget reasons; absence from it alone is not evidence of `disable-model-invocation`.

OAR `skills()` on this fixture (one process, 368 to 502 ms): `user-skill` (user, `userInvocable: false`, no description), `demo-skill`, `deploy` and `ucmd` with paths, descriptions without the label and `userInvocable: true`, and `hidden-skill` (scope project from Claude's label, description, `userInvocable: true`, no source or path).

Not covered by this fixture, so not claimed: whether built-in, plugin, synced or policy skills absent from the commands are user-invocable (left unknown), and whether a context list that omits skills for its budget also omits user-invocable ones (the result is marked `partial` when `includedSkills < totalSkills`).

Reproduce: `pnpm tsx` a script calling `claudeRuntime.skills(installation, { cwd, env: { HOME } })` against the fixture; the unit control is `tests/skill-provenance.test.ts`.
