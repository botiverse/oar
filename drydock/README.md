# drydock — drive a runtime with no daemon present

`drydock` is the **runner**: an independent entry point that starts and drives a
runtime, script-driven, with transcript recording and replay. `sea-trial` is the
**suite of cases**; drydock is the vehicle those cases run in.

## The one claim this exists to test

> Someone without our daemon can drive this runtime.

Everything else about a library like this is self-certifiable. *"The abstraction
is clean"* can always be asserted by its author and never disproved by them.
This one either holds or fails loudly, which is exactly why it is the gate.

⇒ **Therefore drydock must not import, require, or assume any daemon concept.**
Not a host, not a server URL, not an agent id, not a credential broker. If a
type from that world appears here, the claim quietly stops being tested while
still appearing to pass.

## Why it is separate from `sea-trial`

```
drydock    the vehicle -- can start and drive a runtime, alone, on a laptop
sea-trial  the judgement -- the cases every driver must pass
```

They are separate because the vehicle is useful on its own (debugging a single
runtime by hand) and because keeping the judgement out of the vehicle stops the
suite from quietly depending on the runner's conveniences.

## `probes/` — first contact with a real runtime

A probe is not a conformance case; `sea-trial` is that. A probe answers *what
does this runtime actually do*, by running it, so that the driver encoding the
answer is written from an observation rather than from a reading of somebody
else's adapter.

```
node drydock/probes/codex-handshake.ts     # requires `codex` on PATH
```

Each probe exits non-zero on any unmet expectation, and each must be shown to
**fail** with its runtime absent — a probe that cannot go red is decoration.

⚠️ The codex probe earned that rule the hard way. Its first version put all
reporting in the `exit` handler; Node emits `error` and may never emit `exit`
when a spawn fails, so with `codex` missing from PATH it printed nothing and
exited **0**. It passed loudest exactly when the runtime it exists to contact was
not there at all — this project's own thesis, an absence reported as a success,
reproduced inside its own instrument. Reading the code did not catch it; running
the negative control did.

⚠️ Two earlier attempts at that control were themselves invalid, which is worth
more than the fix: the first removed `node` from `PATH` along with `codex` (so
nothing ran), and the second pointed `PATH` at node's own directory — which is
where `codex` also lives, putting back the very thing being removed. **A control
must be shown to have removed what it claims to remove.**

## Lint allowance, recorded here rather than in the config

`.oxlintrc.json` relaxes `import/no-nodejs-modules` for `drydock/**` and nowhere
else. This repository's standard is that every rule turned off is accounted for,
and the config format has no comment field, so the account lives here:

- **Why off here.** Spawning a child process is drydock's entire purpose. A
  runner forbidden from importing `node:child_process` cannot run anything.
- **Why it stays on in `src/`.** The library must remain host-agnostic. A
  consumer embedding oar should not inherit a Node dependency through the
  contract layer, and this rule is what stops that happening by accident.
- **What would count as a change.** Widening the allowance to `src/` is a design
  decision to argue in the open — the contract layer acquiring a host dependency
  is precisely the drift this split exists to catch. It is not a lint edit.

## Naming, since it has changed once

`drydock` was originally the name of the whole project. The project is now
`oar`; `drydock` names only this runner. The maintenance-yard connotation is
right for a runner and was wrong for the library.
