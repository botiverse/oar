# DSH scoped system prompts

Observed on Linux x64, 2026-11-16, with published DSH 0.2.2-rc.1 and the
supported minimum 0.2.1-rc.5. The initial probe passed the same nine native cases on both versions. All
provider traffic went to the local synthetic provider; no account was used.

`systemPrompt` replaces DSH's assembled system text. `appendSystemPrompt`
adds literal text after the native persona suffix. With both options, the
replacement and append are joined with two newlines inside one native
`complete` section: native complete sections suppress ordinary sections.
Tool declarations and other native request context are still present.

## Observations

The [selected frames](selected.json) retain the exact custom text from native
`system/message` persistence and the corresponding provider messages. Native
DSH sends the text using the `developer` role. The [manifest](manifest.json)
identifies the retained full local files by path and SHA-256; full request
bodies and native default prompts are not committed.

| Case | Native observation on both versions |
| --- | --- |
| Replacement | Persisted text and provider text exactly equal `OAR replacement {{literal}}`. |
| Append | Native prompt remains, followed by `OAR appended {{not_a_variable}}`; braces remain literal. |
| Both | Exactly the replacement, two newlines, then append. |
| Resume | Changed values are re-registered before the next turn. Omitting both restores the native prompt rather than carrying the previous override forward. |
| Creation hook | A hook queues input during creation and resume. The first provider request already contains the requested prompt. |
| Native complete conflict | Both replacement and append refuse at open with `UnsupportedOptionError`; zero provider requests. |
| Creation-hook complete conflict | A hook adds a conflicting complete section and queues input. Both options refuse before any provider request. |
| Same-process sibling | A second agent in the same bridge process retains its own native prompt. |
| Native child | A native subagent uses its own default prompt, not the parent's override. |

Registration runs in the native setup callback on `agent.scope.ctx`.
Confirmation runs in a scoped `agent/created` listener after existing
creation listeners, while native publication maintenance still blocks queued
input. The bridge checks the native assembled section and refuses a lost or
conflicting prompt. It does not rewrite provider requests.

The result is scoped to ordinary open/resume and creation-time hooks. This
probe does not establish behavior after compaction or after a plugin changes
prompt sections later during a session. Both prompt options declare
`provided: "immediate"` and `omitted: "default"`; the resume tests derive
their expectations from those public declarations.

## Reproduce

Install each DSH version separately, put that installation's executable first
on `PATH`, and run:

```sh
OAR_TEST=dsh-aimock CI=1 pnpm exec vitest run sea-trial/vendor/dsh-system-prompt.vendor.test.ts
OAR_TEST=dsh-aimock CI=1 pnpm run sea-trial
CI=1 pnpm run check
```

The [native regression](../../sea-trial/vendor/dsh-system-prompt.vendor.test.ts)
creates isolated state and a loopback provider, then compares native logs and
outgoing requests. It writes full raw evidence below `oar-trial-run/`.
The focused missing-service tests also verify typed refusals on both open
and resume.

Initial validation: native vendor cases 9/9 on each version; published DSH
behavior 18 passed, 1 skipped; full local check 4,434 passed, 601 skipped,
plus mock behavior 18 passed, 1 skipped. The skipped tests are the normal
unselected native backends and optional mock case.

## Independent review and retained failures

An independent subagent reviewed the bridge, adapter, native source, docs and
probe. Its first review found that a global native complete prompt could
suppress append, and that registering after creation allowed a creation hook
to start before the override. A subsequent adversarial control found that a
creation hook could itself add a complete section after setup. All three
cases now have native regression coverage. Final review reported no
remaining blocking findings after the nine latest-version cases passed;
minimum-version and full validation completed afterwards.

Earlier raw logs remain local, including the initial incorrect assumption
that children inherit the parent prompt, the conflict fixture that omitted
its required service injection declaration, an initial ESM probe-launch
error, and a lint failure in test fixture record handling. Those preparation
and expectation failures are separate from the implementation defects found
in review; this was not a single clean first attempt.

Source anchors:

- [System prompt service, master 39163dd3](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/system-prompt/src/index.ts): section ordering, complete semantics and literal rendering.
- [Agent publication, 0.2.2-rc.1 source](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/index.ts): setup, creation notification and maintenance ordering.
- [Agent scope, minimum-version source](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent-loop/src/agent.ts): agent-local scope.

## Integration with native names and tool denial

After the name/tool-denial change merged, both controls and prompt registration
share one native setup callback on create and resume. A combined native case
checks literal replacement plus append, hidden denied tools, and preservation
of the saved title on resume. The nine original prompt cases and seven native
name/tool cases remain as independent controls.

The combined revision passed 17 native cases on each version (10 prompt/setup
cases and the seven name/tool controls), plus 18 shared behavior cases on
0.2.2-rc.1. The selected frames include the combined open/resume control.
Prompt setup was moved to an embedded source fragment to keep the bridge file
within its lint limit; the generated plugin remained byte-for-byte identical.

Full validation of the combined revision: 4,456 unit tests and 18 mock
behavior cases passed; the ordinary unselected native cases stayed skipped.
