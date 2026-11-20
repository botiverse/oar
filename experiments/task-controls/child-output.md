# Reading a child result while the parent is idle

Each Linux control below sent one host prompt to a real runtime. A loopback
provider held the child's final model response while the host read root
`status()` and `tasksOf(records, rootId)`. On release the child returned a
distinct marker. The observation checked its text, attribution and ordering
relative to the root turn end. Parent-model requests were inspected separately.
Only the negative delivery checks needed a second host prompt.

| Runtime and mode | While child was held | Where the host received the marker |
| --- | --- | --- |
| Claude Code 2.1.326 foreground | Root running | Parent tool result before the root turn ended |
| Claude Code 2.1.326 background | Root idle, agent task running | Attributed child text after root turn end, before any new host prompt |
| Codex 0.169.0 background | Root idle, agent task running | Child thread's streamed `text_delta` parts joined to the full marker between turns. The parent task end carried status. |
| DSH 0.2.2-rc.5 background | Root idle, agent task running | Child session's text after the originating root turn. Settlement can also start another native root turn. |
| Grok 1.0.70 foreground | Root running | Parent tool result before root turn end |
| Grok 1.0.70 background | Root idle, agent task running | Native `subagent_finished.output` on the root at completion. OAR exposes this string as `task_ended.output` and `TaskView.output`. |
| OpenCode 1.19.5 and 2.2.7 foreground | Root running | Parent tool result before root turn end. Only 2.2.7 also delivered attributed child text. |
| OpenCode 2.3.2 background | Root idle, agent task running | Attributed child text between turns. The 2.3.0 [recording](../opencode-child-background/enabled.json) also contains this ordering. |
| Qwen 0.27.4 foreground | Root running | Parent tool result before root turn end |
| Qwen 0.27.4 background | Root still running at the observation, agent task running | The child's result reached the parent model. The typed host records contained task completion and no marker, including after a follow-up. Host result delivery remains unknown. |
| Kimi 2.6.3 ACP foreground | Root running | Parent tool result before root turn end |
| Kimi 2.6.3 ACP background | Root idle, no projected task | No marker in ACP output or the subsequent parent request through the next prompt. Delivery remains unknown. |
| Qoder 1.1.83 | The [native recording](evidence/qoder-1.1.83.json) establishes agent task lifecycle | No independently correlated child-output marker was retained. Delivery remains unknown. |
| Factory 1.12.1 | The isolated Task call reported that the droid daemon could not be reached. No child request reached the scripted provider | Delivery remains unknown. |
| Cursor, Devin, Antigravity, CodeBuddy, Pi in both modes, Pi Durable, community Cybion and Morph | No controlled child output for these adapters | Delivery remains unknown. Their adapters have no native task lifecycle projection. |

The root's idle state describes root input admission. A background child can
still be running or produce output after root completion. Use the root's
task view for work and the attributed child stream or native task output for
the result. A parent can receive a settlement notification under its own
native policy. See the [DSH settlement controls](../dsh-settlement-notifications/README.md).

`sessionCapabilities(installation).subagentResults.foreground` names a
verified parent tool result in the originating turn. A declared background
mode identifies the source of child output that can reach the host without a
new parent input. Missing modes are unknown. Completion, a notification
summary and the child's actual text are separate facts.

`taskEventTypes` lists observed classes with native task lifecycle events.
An empty list identifies an adapter without a task projection. An absent
field means unverified. A nonempty list does not promise coverage of every
tool, extension or way the runtime can launch work. Claude also has a [recorded workflow task](../../docs/runtimes/claude.md#workflows) on 2.1.292. Installed versions and
[earlier task controls](README.md) determine the declarations.
