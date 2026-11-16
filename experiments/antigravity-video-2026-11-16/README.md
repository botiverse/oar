# Antigravity native video read: direct ACP and OAR

A user reported `read_file` returning HTTP 500 for a video through OAR while
Codex could read it. The first external control, on armbian-jojo with agy
1.5.9 and `gemini-3.8-flash-high`, read a three-second 320x240 H.264/AAC video
successfully through the native CLI. That external control included additional
shell commands and is not a result produced by this probe. The corrected direct ACP and OAR runs also completed without a 500.
The original user's video size, format and model are not yet established.

`probe.ts` runs two prompts sequentially against the existing login, once
through explicit ACP initialize/new/config/prompt requests, then once through
OAR's public session API. It requests the native `read_file` tool, with no
frame extraction, transcoding or fallback. Do not repeat the CLI control.
Only the following baseline pair is currently requested; other models and
larger files require a separately agreed run.

From the repository checkout, with Node 24 or later and dependencies installed:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx experiments/antigravity-video-2026-11-16/probe.ts \
  "$(command -v agy)" /tmp/it-agy-video-probe/probe.mp4 \
  gemini-3.8-flash high /tmp/it-agy-video-probe/acp-oar-canonical.json 180
```

Model and effort are separate arguments; no model-alias normalization is performed.
The agy binary, video and output must be absolute paths. The number is the
prompt deadline in seconds for each route. Each request used to open a native
session has a 30-second limit; cleanup has its own recorded deadline. The
probe uses the current login and native configuration without modifying them
and makes no automatic retry. Check the reported agy version before using the
results as evidence for 1.5.9.

Return `acp-oar-canonical.json`. It contains UTC times, video SHA-256 and byte size, exact
model and prompt, both directions of ACP, native stderr, public OAR records,
turn results, failures and exit observations. The file is written after each
route, so a completed first route survives a later failure. A private temporary
directory also keeps each route's incremental JSONL and wrapper; its path is
in the output. These are retained rather than automatically deleted.

## What the comparison isolates

Both routes use identical native ACP arguments, cwd, inherited environment,
client capabilities and permission/terminal handling. They share OAR's SDK
transport and terminal process utilities; the direct route sends
the model and effort protocol requests and does not use the session adapter's opening,
model-confirmation or turn-record mapping. Thus this compares the public OAR
mapping with explicit ACP, not two independent transport implementations.
Native terminal capability is implemented, even though the prompt asks the
model not to use a shell. Any unexpected terminal request remains in the trace.

A small executable wrapper copies complete protocol lines to evidence before
passing the original bytes unchanged. It is used in both routes and also
captures opening failures before OAR returns a Session. Native exit code and
signal are recorded when the wrapper observes them. If force cleanup prevents
that callback, `nativeExit.observed` is false; the wrapper exit code and OAR
`exited` records must not be presented as a native exit code.

An `end_turn` only proves that the native turn ended. Inspect the `read_file`
call, tool result and final content to decide whether the model actually read
the video. No automatic success classification hides a warning or a 500.
The probe's command exit does not classify model success; the JSON is the
result. Protocol errors and missing model confirmation remain failures in it.

Credential-shaped keys, inherited credential values, bearer/JWT tokens and
email addresses are removed before evidence writes. No auth file or environment
dump is collected. Paths, video contents returned by native tools and model
text may still be private: use the synthetic video and inspect the JSON before
publishing it outside the task.

## Synthetic validation

```sh
pnpm exec tsx experiments/antigravity-video-2026-11-16/probe.ts \
  --self-test /tmp/agy-video-probe-controls
```

The embedded fake ACP server exercises normal completion, a native 500 error,
a stalled prompt, a mismatched model response and a mismatched effort response on both paths. It never starts
agy, reads credentials or contacts a provider. These are newly built controls,
not native video evidence. The fake `.mp4` is intentionally plain fixture text.

The first probe version's [selected control results](controls-selected.json) retain all eight route
outcomes and the SHA-256 of each full local JSON. Both normal turns completed;
the 500 stayed a protocol error on the direct path and a failed provider
outcome through OAR. Both stalled prompts hit the observation deadline and
cleaned up. Both mismatched models refused before prompting. Native exits
were observed in all eight cases, with no reported cleanup failure. Earlier
probe/lint preparation attempts remain local; these selected controls are the
final run, not a claim that preparation succeeded on its first attempt.

Before the handoff, `CI=1 pnpm run check` passed on main `af929424`:
4,407 unit tests and 18 mock behavior cases. These checks validate the probe, independently of the native observations below.

## First native attempt: stopped before video input

The first two-route run used the CLI-style alias `gemini-3.8-flash-high`.
Native agy 1.5.9 advertised `gemini-3.8-flash` and a separate `thought_level`
menu. Its set-model response reported that bare model with effort `high`.
Both the direct probe and OAR refused the mismatched model, before sending
`session/prompt`; this run says nothing about native video reading.
The original result is retained locally and the cited handshake fields are
in [first-native-selected.json](first-native-selected.json).

The corrected run explicitly sets the advertised model and then the advertised
effort option, and confirms both from native responses before prompting.
It ran both routes again because neither original route reached the video.
OAR alias compatibility is a separate task and is not changed by this probe.

The revised probe passed [ten synthetic route controls](controls-effort-selected.json),
including refusal of the requested effort before prompting on both paths.
All ten native exit callbacks were observed; no cleanup failure was reported.

The corrected probe also passed `CI=1 pnpm run check` on main `ce64b26a`: 4,407 unit tests and 18 mock behavior cases.

## Corrected native comparison

agy 1.5.9 on the same logged-in Linux host, probe `e7fbeb23`, explicit
`gemini-3.8-flash` and `high`, same 42,267-byte synthetic video:

| Route | UTC | Native tool | Turn and process | Model answer |
|---|---|---|---|---|
| CLI control | 05:17:46 tool step | Successful `read_file`, then five `run_command` calls | Reported completed | Reported pattern, counter and 440 Hz tone; not a shell-free audio control |
| Direct ACP | 06:38:56 to 06:39:13 | One `read_file`, completed | `end_turn`, native exit 0 | Pattern and counter; says no sound detected |
| Public OAR | 06:39:13 to 06:39:29 | One `read_file`, completed | Completed outcome, native exit 0 | Pattern and counter; says no sound detected |

[Selected native evidence](native-canonical-selected.json) retains exact
answer text, tool-notification field names, exit observations and the full
local evidence fingerprint. No 500 occurred in either corrected trace. This
42 KB, three-second H.264/AAC case does not reproduce the reported failure.
The user's original file size, container/codecs and selected model remain
necessary to narrow that report; other models and sizes have not been run.

The ACP `tool_call_update` frames contain path, call identity and status, but
neither `content` nor `rawOutput`. Neither image/video nor audio tool payload
is exposed on that wire. The model's answer is an observation about its
response, not proof of which media reached the provider. The native
`promptCapabilities.audio=false` advertises prompt-input support; it does not
establish whether an internal `read_file` forwards a video's audio. Direct
ACP reproduces the no-sound answer independently of OAR's session mapping,
but the available trace cannot establish an ACP audio-drop defect or its
cause. No upstream audio-loss issue is warranted from these observations. No
extraction workaround or audio substitution was used by either corrected
ACP route. The earlier CLI control was not subject to that restriction.

The external [CLI storage inspection](cli-media-selected.json) found one
inline `video/mp4` in the stored `read_file` result, 42,267 bytes, identical
to the source file. Container inspection reports H.264 video and mono AAC
at 44.1 kHz. There is no separate audio MIME part in that stored tool step.
The native CLI then made five `run_command` calls, so its final 440 Hz claim
cannot serve as a clean observation of model hearing. The decoded protobuf
field numbers have no schema, and a stored native tool result does not prove
provider ingestion. The ACP traces do not expose corresponding stored media
or provider payloads. All three paths used the same input file; the evidence
does not establish identical provider-facing payloads or locate a model
capability defect.

**Disposition:** withdraw the audio-loss hypothesis, do not file upstream,
and park the original 500 investigation until the user's video byte size,
container/codecs and exact model/effort are available. The small baseline
succeeded on all three paths; no claim is made about the failing user file.
