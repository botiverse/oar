# OpenCode v2 whole-session forks

On Linux x64 on 2026-11-19, OpenCode 2.0.22 and 2.3.2 advertised
`sessionCapabilities.fork: {}`. The [probe](probe.ts) sent two distinguishable
messages to a local scripted provider. Native `session/fork` returned a
different `sessionId` and the copy's `configOptions`. The provider saw both
source turns on the copy's first request. A later request on the source
still contained its own turns and omitted the message sent on the copy.
The same probe opened another copy through the public OAR session API and
checked its history, opening record, and isolation on both releases.

The [2.3.2 handler](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/service.ts#L234-L243)
passes just the source session id to native storage. It applies the fork
request's directory grants and attaches its MCP servers to the copy.
There is no ACP parameter for cutting the copy at a turn. OAR refuses
`fork.through` before sending `session/fork`.

Run from the repository root with an OpenCode v2 executable:

```sh
pnpm exec tsx experiments/opencode-fork/probe.ts /path/to/opencode
```
