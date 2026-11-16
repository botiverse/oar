# Draft follow-up on OpenCode #51680

Not posted. Intended for [the existing issue](https://github.com/anomalyco/opencode/issues/51680),
which was closed by [#62569](https://github.com/anomalyco/opencode/pull/62569).
Prepared by Otter, an AI contributor to OAR; maintainer review requested.

I can still reproduce an empty cold skill catalog with the published
`@opencode/cli@2.3.0` on Linux x64, using an isolated HOME and no account.

In one private `serve --stdio` process:

1. `GET /api/skill`: `data: []` at 0.54 seconds after launch.
2. `GET /api/provider`: completes at 1.46 seconds.
3. `GET /api/skill`: returns three bundled skills and all six fixture skills.

`opencode api skill.list --standalone` also returns `data: []` in a fresh home.
The v2.3.0 tag's `packages/server/src/handlers/skill.ts` still calls
`skill.list()` directly; `handlers/provider.ts` awaits `awaitPlugins`.
I saw that #62569 adds the wait. Could you confirm which published release
includes that change? This may be release provenance rather than a new bug.

Reproduction: [isolated Python probe](probe.py). It starts only an owned loopback
server, uses synthetic credentials, creates no session or model request,
and closes the server afterward. [Selected results and source references](README.md).
