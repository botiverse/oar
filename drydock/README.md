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

## Naming, since it has changed once

`drydock` was originally the name of the whole project. The project is now
`oar`; `drydock` names only this runner. The maintenance-yard connotation is
right for a runner and was wrong for the library.
