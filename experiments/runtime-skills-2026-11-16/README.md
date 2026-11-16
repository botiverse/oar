# Native skill catalogs: Kimi, Claude and Grok

Linux x64, 2026-11-16. Kimi 2.6.2, Claude Code 2.1.325 and Grok
1.0.77 (`50ca579fa996`). These are discovery calls without model prompts.
Kimi and Claude use disposable homes; the Grok bundled-skill control also
reads the existing local cache. It does not sign in or create a session.
[Selected observations](selected.json) contain the fields cited below;
[raw manifest](raw-manifest.json) fingerprints retained local observations,
including failed controls.

## Kimi: use the native Web workspace catalog

| Candidate | Observed interface and boundary |
|---|---|
| CLI | No independent skill-list subcommand in 2.6.2; `--skills-dir` configures loading |
| ACP | No independent skills method in the registered routes; session commands describe a different catalog |
| Node SDK | `Session.listSkills()` requires a session; `visibleBuiltinSkills` is an internal agent-core filter, not a public Node SDK export or a complete user/project catalog |
| Web | `GET /api/v1/workspaces/{id}/skills` resolves the native workspace catalog without a session |
| OAR directory scan | Would need to reproduce native built-in switches, plugin loading and precedence; built-ins are also compiled into the CLI |

Source inspected at
[`6a8493df`](https://github.com/MoonshotAI/kimi-code/tree/6a8493df3e1d796a63f7c7ca0de76c1e690cd943):
[ACP routes](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/acp-server/src/server.ts),
[SDK exports](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/node-sdk/src/index.ts),
[built-in filter](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/agent-core-v2/src/features/skill/catalog/builtin/builtin.ts),
[Web skill routes](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/kap-server/src/routes/skills.ts).

The [probe](../inventory/kimi-skills.py) starts
`kimi web --no-open --host 127.0.0.1 --port 0`, registers an owned workspace,
queries its skills and unregisters it. The native registration contract
creates a fresh ID per call. It neither reuses nor removes a user's existing
workspace. Startup output includes a bearer token; the probe and adapter
consume it privately and never forward stdout/stderr or include it in results.

The final paired samples took 1,990/1,915 ms to start and 2,259/2,185 ms
through the query and unregister operation. With `builtin_product_skills`
true, native returned nine built-ins plus three fixture skills; false returned
four neutral built-ins plus the same three fixtures. Fixtures were loaded from
`KIMI_CODE_HOME/skills`, `HOME/.agents/skills` and project `.agents/skills`.
These samples establish those paths in this configuration, not every possible
plugin, extra-directory or precedence case. The existing config bytes stayed
unchanged and both before/after session lists were empty.

Startup and discovery still write native state: `projects.json`, locks,
query/session indexes, logs, a device ID and `server.token`. The latter is
persistent, created with mode 0600 when absent and reused later; it is not a
one-use token. OAR does not remove these native files. It unregisters only
its own workspace; interruption can leave that registration behind. The
native process tree is killed and awaited on success, error and timeout.

A malformed-frontmatter fixture was skipped by Kimi and absent from the native
response, without an item-level diagnostic. OAR returns `partial:false` for a
complete successful native catalog. This does not assert that every file on
disk parsed successfully. Invalid JSON, malformed catalog shapes, failed
requests and timeouts instead return `unavailable`, never an empty success.
The view is `discovered`, not the contents of an existing agent's context.

A native regression caught a transport detail: adding an empty JSON content
type to DELETE produced a nonzero native envelope despite HTTP 200. The
adapter now sends that header only with a JSON body and validates both layers.
The original failing sample is retained in the manifest.

## Claude: built-ins are already returned

The existing `get_context_usage` reader on Claude 2.1.325 returned 13 built-in
skills in an empty home, including `update-config` and `claude-api`, each with
native `source: "built-in"`. Adding a project `.claude/skills/oar-claude`
fixture returned it with `source: "projectSettings"` and kept those built-ins.
No adapter change was needed. This remains a `context` view; it is not proof
that all commands or installed skills are in that context.
[Probe](../skills-builtins.ts).

## Grok: cached bundled skills were present, provenance was lost

An empty Grok home returned an empty discovery list. That is not evidence that
Grok has no built-ins. The existing local cache returned 32 skills, including
22 with native `source.type: "bundled"` and paths beneath
`~/.grok/bundled/skills/`, for example `docx` and `pptx`. Only those bundled
entries are published here; unrelated user entries are excluded.
[Native-only probe](../inventory/grok-bundled-skills.py).

Grok 1.0.77's native source is an object `{type, path}`. OAR previously kept
only string sources, losing both fields. The adapter now maps that native
object to `source` and `path`, and retains older string sources. The same 22
bundled entries survived the public reader after this change. OAR does not
infer provenance from a name or reclassify compatibility skills as built-ins.

The [native guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md)
describes the separate bundled cache and suppression of project skills in
untrusted workspaces. Our isolated-home project fixtures did not appear;
that negative observation alone does not establish whether a directory is
supported. A directory-loading implementation needs separate trust and
loading controls, and is outside this batch.

## Validation and reproduction

```sh
python3 experiments/inventory/kimi-skills.py /absolute/kimi output-kimi.json
pnpm tsx experiments/skills-builtins.ts /absolute/claude /absolute/grok output.json
# Optional existing-home read, still no prompt; output may contain local user paths.
OAR_SKILLS_EXISTING_GROK=1 pnpm tsx experiments/skills-builtins.ts /absolute/claude /absolute/grok output.json
python3 experiments/inventory/grok-bundled-skills.py /absolute/grok output-bundled.json
OAR_TEST=kimi-skills OAR_KIMI_BIN=/absolute/kimi pnpm vitest run sea-trial/vendor/kimi-skills.vendor.test.ts
```

Kimi's unit regression failed before adding the runtime reader; Grok's source
regression failed before projecting object sources. Both pass afterward.
The native Kimi suite passed on 2.6.2 and the existing CI pin 2.4.1: normal
query, transport failure and timeout each leave no observed child process or
listening port. It runs alongside the existing Kimi login tests in the
three-platform check jobs. Local observations here are Linux only; the new
macOS and Windows CI outcomes must be read from the pull request.

Full local checks passed: 4,443 unit tests and 18 mock behavior cases.
No inference quota was used for these controls. A lighter independent native
query is requested in the [upstream issue draft](upstream-issue-draft.md),
which has not been submitted.
