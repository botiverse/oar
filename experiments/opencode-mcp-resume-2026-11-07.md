# OpenCode 2.2.6: repeated cold MCP resume

Checked November 7, 2026.

**All 40 cold resumes called echo:** 20 with stdio and 20 with HTTP, on
Linux x64 using `@opencode/cli` 2.2.6 and a local scripted provider. Both
warmed initial sessions also called it. This is the unchanged
[`opencode-mcp-resume-local.ts`](opencode-mcp-resume-local.ts) probe used for
the [November 6 failures on 2.2.5](runtime-version-checks/2026-11-06.md#opencode-225-cold-mcp-resume-after-upstream-closure).

| Version and run | Transport | Initial echo | Cold-resume echo | First-request catalog notices |
| --- | --- | --- | --- | --- |
| 2.2.5, November 6 | stdio | 1/1 | 0/3 | Resumes reported echo removed |
| 2.2.5, November 6 | HTTP | 1/1 | 0/3 | Resumes reported echo removed |
| 2.2.6, initial November 7 check | stdio | 1/1 | 3/3 | None |
| 2.2.6, initial November 7 check | HTTP | 1/1 | 3/3 | None |
| 2.2.6, expanded November 7 check | stdio | 1/1 | 20/20 | None |
| 2.2.6, expanded November 7 check | HTTP | 1/1 | 20/20 | None |

Each transport uses its own isolated home and session. Its first process
completes a seed turn with a 250 ms first-token delay, then calls echo. Each
subsequent process resumes the same session with the same MCP configuration
and requests its tool call immediately. The provider forces `execute` to
call `tools.echo.echo` once per marker; it does not invent an echo result.
There is no resumed-turn sleep, retry, remote model or account login.

The expanded run exited zero. All 42 tool turns reported completion, and
an independent read of the raw provider requests found all 42 distinct
`tool_result` markers, including:

```text
echo:LOCAL_MCP_stdio_20 via=stdio token=none
echo:LOCAL_MCP_http_20 via=http token=none
```

No provider request in that run contained the tool-removal notice. This
checks execution and the model-visible transcript, not just a completed
turn. It does not cover Windows, macOS, real-provider timing, changed MCP
configuration or every possible catalog race. The older 2.2.5 failures
remain evidence; this does not establish the first fixed release.

[Upstream #54794](https://github.com/anomalyco/opencode/issues/54794#issuecomment-6670515027)
was closed with a claim that 2.2.4 and later were fixed. Our measured
boundary is narrower: 2.2.5 failed the previous control and 2.2.6 passes
these repeated controls; we did not test 2.2.4. This recheck supports closing
the OAR follow-up for the observed path without adding an adapter workaround.
[OAR #371](https://github.com/botiverse/oar/issues/371) was already closed
on October 23; the new result is added there without reopening it.

## Reproduce and retained evidence

OAR checkout: `80f02de1540260c1b915a5e8f1b72fe5ad187044`. The probe is byte-identical to
its November 6 version. Set `OAR_OPENCODE_BIN` to the installed 2.2.6
executable and use Node 24:

```sh
OAR_OPENCODE_BIN=/absolute/path/to/opencode pnpm tsx experiments/opencode-mcp-resume-local.ts /tmp/opencode-mcp-226.json 20
```

The summary JSON contains all 42 observations. Its `.stdio.raw.json` and
`.http.raw.json` sidecars retain the provider requests, including local paths;
they are kept locally rather than committed. SHA-256 of the retained run:

| Evidence | SHA-256 |
| --- | --- |
| Probe | `28e9e2e76cd6c5343bca43a602546d50189cf72377a272b94ba8b83a0cf190fd` |
| Summary | `ea021dee50470fc0e63ab0a8c136af656960ebb17ac661a93ac3cd857086257a` |
| stdio raw requests | `e262417133f4086535c2864713fdebb3ca9548777c7c7653f1a1841966fc5fc6` |
| HTTP raw requests | `6348cfa07438a0b63587a21b700cdb8c069a8746aa909261ec310010f744b5dd` |

The OpenCode v2 CI installation remains pinned to 2.2.5 in this documentation
change; this targeted Linux check is not a replacement for its normal
cross-platform validation.
