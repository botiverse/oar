# Antigravity: one input's size, and the MCP child environment (2026-11-12)

Run by IT-hetzer-host on a machine with a signed-in agy 1.5.6 (Linux), through `@botiverse/oar` 0.102.0, in temporary directories that were removed afterwards. No prompt text, model text beyond the checked code words, or account details were kept. The probes are in this directory.

## One input's size

**Round 1** (`agy-probe.mjs size`): one prompt of 250,110 bytes, filler first and the instruction plus a code word at the end. It did not finish within 240 s: the model kept using tools to look through its own session records. A separate look afterwards ([round1-diagnostic.json](round1-diagnostic.json), the session id removed) found:

- agy's `transcript_full` held the first input as 192,159 bytes with `<truncated 58527 bytes>`, and without the closing instruction;
- the conversation database's step 0 payload (501,857 bytes) kept the closing instruction and no truncation notice.

That alone could not tell a cut model input from a cut transcript.

**Round 2** (`agy-size2.mjs`): the instruction first ("do not use any tools; reply with every capital-letter code word you can see"), one code word right after it and one at the very end.

```json
{"check":"large_prompt_2","agyVersion":"1.5.6","promptBytes":185000,"outcome":"completed","sawStart":true,"sawEnd":true,"replyLength":20}
{"check":"large_prompt_2","agyVersion":"1.5.6","promptBytes":200000,"outcome":"completed","sawStart":true,"sawEnd":false,"replyLength":9}
```

At 200,000 bytes the model never saw the end of its input; at 185,000 it saw all of it. With the transcript cut at 192,159 bytes, the native cut is near 192,000 bytes, as a third-party bridge had reported for agy 1.5.4 (it caps at 180,000). The exact native point was not measured.

**OAR's bound**: 185,000 UTF-8 bytes, the largest size measured to arrive whole. A longer prompt, steer or queued input is refused before it is sent (`unsupported`, `failure: input_too_large`). It is OAR's conservative bound, not agy's cut point; raising it needs a measurement between 185,000 and 192,000 bytes.

## MCP child environment

`agy-probe.mjs env`: a session opened with `SessionOptions.env = { OAR_PROBE_MARK: "present-in-agy-env" }` and one credential-free stdio MCP server that writes `${OAR_PROBE_MARK:-absent}` to a file.

```json
{"check":"mcp_child_inherits_agy_env","agyVersion":"1.5.6","serverStarted":true,"startedBy":"session_open","markerSeenByServer":"present-in-agy-env"}
```

The server started on `session/new` with agy's own environment. A read-only search of `~/.gemini` and `~/.cache/antigravity` afterwards (132 files) found no copy of the marker. That shows only that this run left none. See [antigravity.md](../../docs/runtimes/antigravity.md#session-mcp-servers) for what OAR does with this.
