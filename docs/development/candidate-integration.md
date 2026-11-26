# The candidate branch: upstream sync, build, and publication

This repository also carries a **private candidate branch**: official OAR plus a
set of verified capabilities official OAR does not ship yet, which a downstream
host application runs in production. This page is the fixed procedure for
keeping it in sync, building it, and publishing it.

## What the candidate adds

These are the private capabilities a merge must never drop. Each has its own
tests; a sync that loses one fails `pnpm run test`.

| Capability | Where it lives | Contract |
|---|---|---|
| Host-answered questions with receipt evidence (`questions: "ask"`) | `shared/app-request-questions.ts`, `runtimes/claude/questions.ts` | [app-requests](../spec/app-requests.md) |
| Host-answered approvals (coordinator, no vendor opt-in yet) | `shared/app-request-answers.ts` | same page |
| Native plan/checklist observation, including an extension-provided channel | `contracts/plan.ts`, `shared/extension-plan.ts`, `runtimes/*/plan.ts` | [plans](../spec/plans.md) |
| Host-owned queue snapshots with evidence-gated restore | `observe/queue-*.ts` | [queue snapshots](../spec/queue-snapshot.md) |
| Pi host-declared provider and compaction budget over RPC | `runtimes/pi/`, `contracts/pi-provider.ts` | [pi](../runtimes/pi.md) |
| DSH host-declared provider, images and native reasoning | `runtimes/dsh/`, `contracts/dsh-provider.ts` | [dsh](../runtimes/dsh.md) |
| Grok reasoning-effort controls and readback | `shared/acp/model.ts`, `runtimes/grok/` | [grok](../runtimes/grok.md) |
| Hermes generic ACP runtime, current-turn steering, session MCP credentials | `runtimes/hermes/` | [hermes](../runtimes/hermes.md) |

The candidate keeps official release numbers (`packages/oar/package.json`
`version` matches the release it is based on) so a host can tell which upstream
contract it is reading. **A candidate build is identified by its git commit,
never by the version alone** — the version is not bumped for candidate work.

The candidate carries no product logic: no product names in the package source,
no automatic installation of another project's extension, no authorization
decision. It only reads what a runtime measured and reports it; anything it
cannot verify it refuses with a reason.

## Sync official OAR into the candidate

Work in a worktree of the candidate branch, never in a downstream host's
checkout.

```bash
cd <candidate-worktree>
git fetch origin --tags
git log --oneline "$(git describe --tags --abbrev=0)"..origin/main   # what is coming
git merge --no-ff vX.Y.Z
```

Resolve conflicts by keeping **both** implementations where the release ships a
second one for a capability the candidate already had, and record the decision
in the merge commit. The conflicts that recur:

- `packages/oar/src/contracts/session.ts`, `contracts/runtime.ts` — the release
  `UserQuestionControl.answerQuestion` against the candidate's
  `answerQuestion(requestId, AppQuestionAnswers, options)`. The candidate keeps
  ONE method whose parameter is `HostQuestionAnswer` (both dialects) and whose
  outcome vocabulary follows the option that opened the session.
- `shared/stream-json/session.ts`, `shared/stream-json/permission.ts` — the
  release question store next to the candidate's coordinator. One of them is
  bound per session; the adapter decides, the driver only reads
  `profile.answerQuestion`.
- `runtimes/claude/session.ts` — both launch shapes survive:
  `questions: "ask"` stays read-only (`--permission-mode default
  --permission-prompt-tool stdio`), `userQuestions: "host"` keeps the release
  bypass-permission shape.
- `runtimes/*/options.ts` — the release adds `userQuestions` refusals to the
  runtimes without a channel. Keep them and refresh
  `tests/refused-session-options.test.ts` from the runtimes themselves rather
  than by hand.

Then, always:

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

A merge is done only when all four are green. `pnpm run check` additionally
runs the sea-trial against real runtimes and is required before publishing.

## Build the package a host vendors

```bash
pnpm run build
(cd packages/oar && pnpm pack --pack-destination ../../artifacts)
```

The artifact is `artifacts/botiverse-oar-<version>.tgz`. Name it
`oar-<version>-candidate-<short-sha>.tgz` so the pinned commit is visible in the
file name, and record `artifacts/<same name>.provenance.json`:

```json
{
  "package": "@botiverse/oar",
  "version": "0.134.0",
  "commit": "<full sha of the code the tarball was built from>",
  "official": "v0.134.0",
  "tarball": { "path": "artifacts/oar-0.134.0-candidate-<short sha>.tgz", "sha256": "<hex>" },
  "check": "typecheck, lint, test",
  "builtAt": "<UTC timestamp>"
}
```

A host pins `"@botiverse/oar": "file:vendor/oar-<version>-candidate-<sha>.tgz"`.
Bumping the candidate is that host's change: replace the tarball, the
provenance file and the pin together, then run its own worker suite, which is
the acceptance gate for the contracts above (the OAR event union, the option
refusals and the question-channel shape).

## Publish to the internal GitLab

`gitlab.corp.youdao.com/hikari/server/assistant/oar` mirrors the candidate for
the internal build pipeline; the public repository stays the upstream source of
truth and only receives generic changes.

```bash
git remote add gitlab git@gitlab.corp.youdao.com:hikari/server/assistant/oar.git   # once
git push gitlab HEAD:main
git push gitlab --tags
```

Rules:

- Push **only** commits that passed the four checks above, and push the branch
  you actually built the tarball from.
- The tarball committed under `artifacts/` must be the one built from the
  pushed commit's code; never rebuild after pushing without a new commit.
- Never force-push `main`. The candidate is a normal fast-forward history:
  release merges plus candidate commits.
- Do not publish a candidate whose version differs from the release it is based
  on; a version change is what tells a host the contract moved.

## What is deliberately not done here

- Authorization (who may ask, who may answer, which tools a person may approve)
  stays in the host application. OAR only reports what a runtime did and refuses
  what it cannot verify.
- A capability OAR has not verified natively is refused with a reason, never
  faked: no synthesized prompts, no optimistic UI state, no checklist derived
  from a tool name, a version or a file on disk.
