# Resume in another working directory

A host that moves a conversation to another directory either resumes the same
native conversation there, when the runtime can, or starts a new one with a
handoff. Which runtime can is measured, not read off a resume method that
takes a `cwd`.

[`experiments/resume-other-cwd.ts`](../../experiments/resume-other-cwd.ts),
run 2026-10-03 on linux x64: open in directory A, teach a codeword, dispose;
resume the same id with `cwd` B; ask the model to run `pwd && ls` and to say
the codeword. Supported means the resume opens, the codeword comes back, and
the shell runs in B.

| Runtime | Version, model | Resume naming B |
|---|---|---|
| claude | 2.1.288, haiku | Supported: the codeword, and `pwd` in B |
| codex | 0.160.0, its default | Supported: the codeword, `pwd` in B, `ls` listing B |
| cursor | `@cursor/sdk` 1.0.35 | Refused at open: the SDK finds an agent only under the directory it was created in (`AgentNotFoundError`) |
| pi | SDK 1.0.0 | Refused at open: pi keeps sessions per directory (no session file under B) |
| grok | 1.0.46 | Refused at open: grok answers the resume with `Path not found.` |
| kimi | 2.1.1 | Natively kept in A without a word (its shell ran `cd <A> && pwd`); OAR refuses at open after reading the session's directory from `session/list` |

A refusal is the runtime's (or for kimi, OAR's) error from `session()`, so a
host that tries a resume in B and falls back to a handoff on refusal never
runs in a directory it did not ask for. Kimi's is an `UnsupportedOptionError`
with `option: "cwd"`
([refused session options](../spec/runtime-matrix.md#refused-session-options)).
Not covered: antigravity (not installed here), and runtimes whose session
store the host moved by hand.
