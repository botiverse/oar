# Draft: ACP 1.5.0 on macOS intermittently omits preloaded MCP tools from the first prompt

Prepared for upstream filing. No upstream issue number has been assigned.

## Observed behavior

With agy CLI 1.5.0 on macOS arm64, using
`acp --dangerously-skip-permissions --process-per-session`, session/new
successfully preloaded a session stdio MCP server. That server answered
initialize and tools/list, then its stdin closed. An immediate prompt's
first main provider request contained no MCP declarations. Calls to
`mcp_echo_echo` and `call_mcp_tool` returned native unknown-tool errors.

This was an isolated HOME using a local scripted Gemini provider and
synthetic MCP servers, without a real account. User configuration contained
echo and userecho; session/new supplied a replacement echo. Expected:
the session echo tool is usable after session/new returns, and the
differently named user server remains available through call_mcp_tool.

Failure: [OAR main run 43346560094, macOS check](https://github.com/botiverse/oar/actions/runs/43346560094/job/131627220977).
The installer and worker logs both identify **1.5.0**. The [previous macOS
run](https://github.com/botiverse/oar/actions/runs/43344246157/job/131619609986)
passed with the same version and identical repository file tree.
Linux and Windows passed in the failing main run.

Within one second of the failed run:

1. Session echo answered initialize at 01:49:47.404 UTC and tools/list at
   .405; stdin closed and it exited at .406.
2. The worker received session/prompt at .420779. At .478 the first main
   model request declared 12 built-in tools but none of mcp_echo_echo,
   call_mcp_tool, list_resources or read_resource.
3. Requests at .506 and .522 contained unknown-tool errors. No MCP server
   received tools/call; the turn finished at .534.
4. The two user MCP processes started at .561 and .570, then completed
   initialize/tools/list at .574 and .583, after the turn had finished.

The retained failure capture includes all three server discovery logs and
both native logs, without truncation or read errors. The cause of the
missing preloaded session tools is unknown; late user startup alone does
not explain it. We are not treating this as a 1.5.7 regression.

## Reproduction attempt and limits

The OAR repository's `sea-trial/vendor/mcp-servers-acp.vendor.test.ts`
contains the unchanged case named "a server named like one of the user's
runs as the session's; the user's other servers stay". Run it with a local
1.5.0 installation and `OAR_TEST=antigravity-aimock`; it uses a scripted local
provider and does not spend model quota. The failure is intermittent.

A separate ACP probe compared session-only, differently named user and
same-name replacement configurations, with zero or 1,000 ms added server
startup delay, on Linux 1.5.0 and 1.5.7. All 12 controls passed, and passed
again while preparing the probe for publication. This does not prove the
failure requires a clash or that 1.5.7 fixes it on macOS.

The public OAR report and scripts are in
`experiments/antigravity-mcp-readiness/` alongside selected event times,
catalog names and echo results. Before filing, link the reviewed commit
containing that directory here.

## Questions for the native contract

- Does session/new guarantee that preloaded session MCP tools are available
  to an immediately following prompt? If so, can this missing-catalog case
  be fixed at that boundary?
- If session/new is not the readiness barrier, is there a supported ACP
  notification or query a host should wait for? Our replies had only
  sessionId, models, modes and configOptions; we saw no MCP-ready update and
  found none in the public ACP reference.
- Is same-name user/server replacement relevant, or can other session MCP
  configurations hit this path?

We have not added a sleep, automatic retry or relaxed assertion. A supported
readiness signal would let the host wait for the intended condition.
