# Release tag permissions: 2026-11-15

The 0.108.1 release published npm packages but could not create its tag with
`GITHUB_TOKEN`. Main acquired a different workflow while that release was
waiting for CI. The release target remained the earlier commit. This is a
permission failure across those two workflow trees, not evidence that every
release containing workflow changes fails.

## Observed timeline

Times are UTC. These are existing production runs inspected read-only; this
investigation did not create tags, publish packages or run an API write probe.

| Time | Evidence | Observation |
| --- | --- | --- |
| 12:09:37 | [Release commit cc162cd5](https://github.com/botiverse/oar/commit/cc162cd565395add80b46215d1ba9f6f862e56ab) | PR #801 sets both package versions to 0.108.1. It includes the earlier workflow change #798. |
| 12:10:16 | [Original release run 43712468685](https://github.com/botiverse/oar/actions/runs/43712468685) | Dispatched from main at cc162cd5; its CI gate waits for that exact commit. |
| 12:24:40 | [PR #802 merge ed69f351](https://github.com/botiverse/oar/commit/ed69f351eeb57c2a2e004a81b87ffe6a5af2b095) | Main gains five lines in `.github/workflows/acp-windows.yml`. This commit is after the release target and is not in v0.108.1. |
| 12:48:43 | [Publish job 132806825471](https://github.com/botiverse/oar/actions/runs/43712468685/job/132806825471) | The original publish job succeeds. |
| 12:48:52 | [Release job 132816746639](https://github.com/botiverse/oar/actions/runs/43712468685/job/132816746639) | GitHub rejects the tag push, naming `.github/workflows/acp-windows.yml` and missing `workflows` permission. |
| 12:52:38 | [Tag-push run 43716066744](https://github.com/botiverse/oar/actions/runs/43716066744) | After Cindy pushes the tag through Stamp, this run checks out cc162cd5. The publish command runs again and reports no new packages; the run succeeds. |
| 12:57:07 | [Recovery from the tag, run 43716430118](https://github.com/botiverse/oar/actions/runs/43716430118) | The `release_only` job refuses because recovery must be dispatched from main. |
| 12:58:01 | [Recovery from main, run 43716487334](https://github.com/botiverse/oar/actions/runs/43716487334) | Only `release_only` runs. It verifies the existing tag and npm versions and creates [v0.108.1](https://github.com/botiverse/oar/releases/tag/v0.108.1). |

The remote `refs/tags/v0.108.1` is a lightweight tag pointing to
`cc162cd565395add80b46215d1ba9f6f862e56ab`. Recovery supports both lightweight
and annotated tags. The release API's `target_commitish: main` is not evidence
that the tag points at current main: that field is unused when the tag exists.

## Permission boundary

GitHub's [create-release documentation](https://docs.github.com/en/rest/releases/releases#create-a-release)
states that a target with workflow files added or modified relative to the
default branch needs workflow-write permission. It explicitly says that
`GITHUB_TOKEN` cannot receive that permission. Thus using
[`gh release create --target`](https://cli.github.com/manual/gh_release_create)
to create the missing tag does not avoid this boundary.

The [create-reference endpoint](https://docs.github.com/en/rest/git/refs#create-a-reference)
also lists Contents write plus Workflows write among its permission sets.
Its reference page does not explain the conditional check in the same detail.
No live `createRef` write was attempted here; it is not a verified alternative
to the failed push. Keep the existing workflow-merge hold until the tag is
confirmed rather than treating an API switch as a permission fix.

The [GITHUB_TOKEN event rules](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)
explain why the normal workflow's tag push does not recursively publish.
Stamp's external tag push is not covered by that suppression, as the extra
0.108.1 publish run demonstrates. Its successful no-op does not prove that
every recovery is complete; exact package versions must be checked first.

## Change and verification

The [development procedure](../docs/development.md#recover-after-npm-publication)
now covers a missing tag, preserves the original commit, and distinguishes
retrying a transient release failure from a permission refusal. It also
records the legacy tag-push side effect. The workflow's version input help
now says to dispatch both modes from main; its former instruction to use the
existing tag contradicted the guard and the observed failed recovery.

The job scripts and their permissions are unchanged. Existing
[`release-only-workflow.test.ts`](../tests/release-only-workflow.test.ts)
executes the recovery script against controlled command responses: correct
lightweight and annotated tags succeed; wrong refs, malformed or moved tags,
missing npm versions, inconsistent release notes and release creation errors
fail without publishing or retagging. These controls check the recovery
logic, not GitHub's server-side authorization.

On Linux, `CI=1 pnpm run check` passed with 4,370 unit tests and 18 mock
behavior checks, including all 18 existing recovery controls. A diff check
also confirmed that only the input description changed in `release.yml`.
