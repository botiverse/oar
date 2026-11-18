# Native skill invocation metadata

On November 18, 2026, isolated Linux controls compared native skill metadata
with OAR's `SkillEntry.userInvocable`. This lets a host show a slash command
only when the runtime establishes direct invocation. No account, paid model
call or skill execution was used. Selected native fields, including their
absence, are retained in [native-observations.json](native-observations.json).

| Runtime and exact control version | Native source | OAR result |
| --- | --- | --- |
| Grok 1.0.70 (`f50904eaee6c`) | `inspect --json` skill `userInvocable` | Copy boolean true or false; omit absent/invalid values |
| Factory Droid 1.12.1 | `droid.list_skills`, `userInvocable` | Copy boolean independently of `enabled` |
| Qwen 0.27.4 | `qwen/status/workspace/skills`, `userInvocable` | Hidden fixture reports false; default and explicit true fixtures omit the field, so OAR keeps them unknown |
| DSH 0.2.1-rc.5 | `skills.snapshot`, `invocation.userInvocable` | Copy boolean independently of model invocation |
| Devin 3000.12.57 (`96542e930752`) | `skills list --json`, `triggers` | A present list containing `user` gives true; a present list without it gives false; missing list stays unknown |
| Pi SDK and RPC 1.5.2 | Loaded SDK skills and RPC `get_commands`, `source: "skill"` | Every loaded skill has a `/skill:name` command and reports true |
| Antigravity 1.5.0 | `/skills` catalog omits `disable-slash-command: true` | Mapping remains absent here; follow-up will cover both the native query and verified file reader |
| Codex 0.169.0 | App-server `skills/list` | No direct-invocation metadata, even for true/false frontmatter controls; omitted |
| Cursor SDK 1.4.1 | Copied SDK's unchanged skill-discovery implementation and native `toJson()` | No direct-invocation metadata for true/false controls; omitted |
| Kimi 2.4.1 and 2.6.2 | Native Web workspace skill catalog | No direct-invocation metadata; `disable_model_invocation` is separate; omitted |
| OpenCode 1.19.5 and 2.2.7 | v1 `debug skill`; v2 `/api/skill` after provider activation | Skill rows omit invocation metadata; v1 has a separate command catalog with collisions; v2 `autoinvoke` is separate; omitted |

Claude already reports this field from its native initialization command
catalog, including explicit negative membership where the native source is
verified. Its mapping is unchanged; see the
[Claude runtime page](../../docs/runtimes/claude.md).
CodeBuddy, Pi Durable and Qoder do not implement `skills()` in this revision;
this change does not introduce new inventory readers.

OpenCode stays unknown in this change. The separate [command controls and
timings](opencode-commands.json) show that v1 offers all four fixture skills as
commands, but a same-named custom command changes its native source from
`skill` to `command` while the skill remains loaded. V2 lists only `init`,
`review` and `goal`; that alone does not prove its skills are non-invocable.
[Follow-up #938](https://github.com/botiverse/oar/issues/938) tracks the join and
its cost: a v1 server through command response took 1.30 s median across three
fresh-home runs, in addition to the existing debug query. No extra server is
added to the product reader.

The positive and negative fixtures are native metadata controls, not merely
inputs to an OAR parser. Grok, Factory and DSH expose both booleans. Devin
exposes user-only and model-only trigger lists. Qwen's explicit true is omitted
by native, so OAR does not fill it in. Pi's native loader ignores
`user-invocable: false`: all four default, true, false and model-hidden fixtures
are still offered by `get_commands`, including with `enableSkillCommands`
disabled. Pi's SDK command expansion also resolves every loaded skill by name;
that setting does not remove them from the RPC catalog. Antigravity's negative
control is omission from the native catalog. Its mapping is deferred until the
[file-reader change](https://github.com/botiverse/oar/pull/937) merges, so this
change does not depend on that implementation.

The Devin source binary was recovered from a retained official archive after
the original download URL returned HTTP 403. The archive SHA-256 is
`0946784ef886d716e82a8026f76933bf0a6e4f0a804a23722bb62047e8c07d4a`;
its own `--version` returned `devin 3000.12.57 (96542e930752)`. No newer binary was
substituted. The meaning of Devin's trigger list is also documented in its
[native skill documentation](https://docs.devin.ai/cli/extensibility/skills/creating-skills).

## Reproduce

Use the exact executable paths produced by the pinned installer, not whatever
happens to be on PATH. These probes create disposable homes and synthetic
skills, remove inherited credentials, use no prompt, and stop their owned
processes. The Web probe retains no ephemeral bearer or skill body.

```sh
python3 experiments/skill-invocability/native.py codex /absolute/codex codex.json
python3 experiments/skill-invocability/native.py grok /absolute/grok grok.json
python3 experiments/skill-invocability/web.py kimi /absolute/kimi kimi.json
python3 experiments/skill-invocability/web.py opencode-v1 /absolute/opencode v1.json
python3 experiments/skill-invocability/web.py opencode-v1 /absolute/opencode collision.json --collision
python3 experiments/skill-invocability/web.py opencode-v2 /absolute/opencode v2.json
python3 experiments/skill-invocability/pi.py pi.json
```

The other native comparisons use the maintained vendor fixtures, which also
compare OAR's result to native and assert no model request:

```sh
OAR_TEST=factory-aimock OAR_FACTORY_BIN=/absolute/droid pnpm vitest run sea-trial/vendor/factory-skills.vendor.test.ts
OAR_TEST=qwen-aimock OAR_QWEN_BIN=/absolute/qwen pnpm vitest run sea-trial/vendor/qwen-skills.vendor.test.ts
OAR_TEST=dsh-aimock OAR_DSH_BIN=/absolute/dsh pnpm vitest run sea-trial/vendor/dsh-skills.vendor.test.ts
OAR_TEST=devin-skills OAR_DEVIN_BIN=/absolute/devin pnpm vitest run sea-trial/vendor/devin-skills.vendor.test.ts
OAR_TEST=pi-rpc-aimock pnpm vitest run sea-trial/vendor/pi-rpc-readers.vendor.test.ts
OAR_TEST=cursor-skills pnpm vitest run sea-trial/vendor/cursor-skills.vendor.test.ts
OAR_TEST=antigravity-aimock OAR_ANTIGRAVITY_BIN=/absolute/agy pnpm vitest run sea-trial/vendor/antigravity-skills.vendor.test.ts
```

Cursor's observer records the native field names alongside its existing parity
result. It copies the SDK without replacing discovery logic, blocks network
connections, and records the source digest. It never prints native skill
contents. Native stderr and full local paths remain outside the selected
public results.

Unknown metadata stays unknown. A runtime recognizing a frontmatter spelling
in some other interface would require a separate native control before using
it here. No additional process or network query is introduced by these field
mappings.
