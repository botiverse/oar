# DSH child settlement ordering

Native DSH 0.2.1-rc.5 on Linux, 2026-11-06, with an isolated home and a local
scripted provider. No account or real model inference was used.

The Windows DSH job on PR #661
([run 42191012453](https://github.com/botiverse/oar/actions/runs/42191012453/job/127802737713))
passed child completion, text and catalog-edge assertions, then found one
root turn ending where the fixture expected two. That run did not retain
this case's records, so its exact ordering is unconfirmed.

Two native controls demonstrate why an uncontrolled schedule is insufficient:

| Controlled order | Native settlement notice | Root turns ended |
| --- | --- | --- |
| Hold the parent's model reply until the child finishes | Notice is consumed in the parent's current turn | 1 |
| Hold the child's model reply until the parent finishes | Notice starts another parent turn | 2 |

Both controls preserve the child catalog edge, child answer and completed task,
and finish idle. [Selected native frames](selected.json) retain the actual
turn starts, notice and turn endings. DSH's installed `dsh-subagent` service
also selects `queue` for an idle parent and `steer` for a running parent.
The missing CI records prevent equating the first control with the Windows
failure; they do establish a missing prerequisite in the old two-turn test.

The vendor test now controls both orders with held model streams. The original
two-turn assertion remains in the parent-first case. The child-first case
requires exactly one turn and checks that the notice precedes its ending.
Both retain the original graph, child-text, task completion and idle assertions.
Provider requests and session records are written on success or failure.
No product code, test deadline or retry behavior changes.

The Linux check passed typechecking, lint, 3,602 unit tests and 18 mock
behaviors. All 22 DSH vendor cases passed, including both controlled orders.

To repeat both controls with the installed runtime:

```sh
OAR_TEST=dsh-aimock OAR_DSH_BIN=/path/to/dsh pnpm exec vitest run sea-trial/vendor/dsh.vendor.test.ts -t 'native child settles'
```

The `OAR_TRIAL_RUN_DIR` artifacts include `dsh-child-before-parent.json` and
`dsh-child-after-parent.json`. Raw diagnostics may contain local paths and
must be reviewed before sharing. Windows validation belongs to the PR CI.
