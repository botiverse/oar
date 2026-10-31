# ACP connection ownership

The internal ACP shared factory separates a process and its SDK connection
from each session's state. This foundation enables no native runtime by
itself. Each runtime still needs its own version/platform admission evidence,
launch-configuration audit, cleanup implementation and documented limits.
The existing isolated path and the shared factory use one session layer for
records, turns, permissions, hosted terminals, usage and credential handling.

## Process configuration and opening

One factory instance owns one pool. Its private key covers the executable,
arguments, captured environment including inherited values, process cwd and
initialize metadata. Initialization and authentication happen once per pool
entry, after a lease's credentials are registered. A new session's cwd, MCP
servers, model and effort still travel in its native session operations.
A vendor must explicitly choose the process cwd; session cwd cannot silently
replace configuration that the executable reads during startup.

Admission also checks same-directory MCP isolation and configuration
freshness: a later shared session must observe the project/user configuration
that a new isolated process would observe then. The generic factory's
per-session arguments alone do not prove that a vendor scopes them that way.
For OpenCode 2.2.3, one canonical directory serves at most one
session for the entire process lifetime. Release does not clear that used
directory. Another open in that directory, including an identical or empty
MCP list, uses a fresh isolated process for `auto` and throws
`UnsupportedOptionError("placement")` for explicit `shared`, before any
native open is sent on the old connection. Peers remain untouched.
Kimi 2.4.1 fails the configuration-freshness requirement and remains isolated;
explicit shared placement is refused. See the
[native comparison](../../experiments/sharing/same-directory-2026-10-30.md).
OpenCode enforces this on Linux x64, macOS arm64 and Windows x64; other
versions/platforms remain isolated or refuse explicit sharing. Its
[runtime audit](../runtimes/opencode.md#shared-launch-ownership-and-cleanup)
defines the stable home launch, process inputs, atomic real-path/file-identity
reservation and native close plus hosted-terminal cleanup. A reservation
refusal precedes any native open, retains peers, and reports actual isolated
placement for auto fallback. Failed native opens retain the reservation.
Qoder's daemon has the same directory lifetime
restriction, documented on its [runtime page](../runtimes/qoder.md).

The official SDK registers a unique outgoing request id before writing it.
Replies resolve that operation, never the most recently opened session.
Initialization failures and transport closure remove the pool entry from
acquisition before stopping the process. Existing waiters fail with that
connection; an open during shutdown starts a fresh entry.
Opening or configuring one session fails only that open and cleans its
explicitly acquired native id. No already-open peer is restarted or replayed.
The connection's initialize reply is not a root session frame.

Reserve a resume/load id before sending the request. For a new session, bind
only the id in its successful native response. An id still controlled by
another lease, including a closing lease, rejects a resume with
`SessionUnavailableError` and reason `in_use`. The cause method `oar/open`
identifies OAR's own ownership check; its native data contains only the
observed session id, not a fabricated native error. A `session/new` reply
reusing an owned or retired id instead raises `AcpProtocolError`: this is a
native protocol violation, not a resume or placement refusal. It never closes
the existing controller. Disposing an owner removes its opening metadata as
well as retiring all its ids.

Cancelling or timing out `session/new` retains its native request id for one
additional session-opening timeout. The tombstone expires if no reply arrives;
connection shutdown clears it immediately. Later unknown replies remain
diagnostics, with no inferred owner. A late
successful reply is diagnosed, its unowned native id is retired, and the
vendor's per-session cleanup is attempted under the normal cleanup bound.
Completion or failure remains a connection diagnostic, including any reason;
a failed cleanup never makes the id reusable. An already owned or retired late id is diagnosed
but never cleaned on behalf of the failed open, since a peer may own it.

A retired id remains unavailable on that connection because ACP does not
prove a generation boundary that would distinguish late old traffic from
a new controller. Before sending any native resume request, `auto` instead
opens an isolated process and records the actual placement as `isolated`.
Explicit `shared` rejects with `UnsupportedOptionError("placement")` and
explains the need for an isolated process. The old pool and its peers remain
untouched; a native resume or configuration failure never triggers fallback.

## Routing and buffering

Route native updates and host requests by an explicitly owned root or a
vendor-proven descendant link. Runtime adapters supply the native association
reader. Unknown ids do not become children merely because they share a
connection. A link is accepted only when its parent belongs to the same root
as the frame carrying it. A peer's frame cannot establish links into another
root, and an unknown carrier must first gain proven ownership. Transitive
links may arrive after a child's update. A delivered frame's links whose parent
is not yet known stay in the same bounded buffer until known ids change,
without delivering the frame twice. A missing parent is not a conflict; a
parent proven to belong to a different root is.

The connection retains at most 256 unowned frames, one MiB of their encoded
params, and one second of waiting by default. While any `session/new` is in
flight, unknown frames retain their place without expiry, still subject to
the frame and byte caps. Once all new requests settle or cancel, the normal
expiry bound resumes. Internal vendor configuration may set those bounds.
Only changes to the known-id set flush pending frames; a frame's conflicting
links are diagnosed once rather than repeated for unrelated traffic.
Matching ownership flushes buffered frames in original
arrival order. Records retain the transport's original `receivedAt`, even
when binding or SDK dispatch happens later; sequence numbers remain dense
append order. Opening replay and live usage are distinguished at the native
open response boundary before asynchronous SDK dispatch.

Reserving a resume id sets a cutoff for the entire controller, including
children and grandchildren discovered by later links. Older buffered frames
for any id subsequently proven to belong to that controller become
`pre_reservation` diagnostics, including host requests. Transport arrival
sequence also rejects a frame received before reservation but dispatched by
the SDK afterward. Only subsequent traffic can be delivered to the new
controller; an id match alone cannot prove the older generation's ownership.

Expiry, capacity, retirement, conflicting links, unknown responses and
unowned connection notifications go to the required redacted connection
diagnostic callback. They never go to an arbitrary root or manufacture a
turn ending. Unowned host requests receive ACP invalid-params errors after
their bounded wait. They cannot create a terminal or use another root's
permission handler. A diagnostic callback's exception cannot prevent that
refusal. SDK validation still applies to typed native requests and updates.

## Controls and cleanup

Each root serializes its controls and dispose; different roots proceed
independently. Permission handling and terminal operations use the same code
as isolated sessions, with one terminal host per root. Both the native
session id and terminal id must match when accessing a terminal.

An abort fallback records OAR release before cleanup and closes the OAR turn.
Late native output and completion remain observable but cannot end the turn
again or admit another prompt. Release and dispose stop accepting new host
requests. Already-running native work can continue, so this does not promise
that all work has stopped.

Native per-session cleanup and hosted-terminal cleanup are attempted
independently, each bounded to four seconds. Failure or timeout remains a
failed `cleanup` result; it is not a successful stop. Abort fallback cleans
once and retains its lease; dispose cleans again. Disposing while peers
remain relinquishes only that lease, detaches its routing and exit listener,
and never kills the pool. Only the last lease stops the process, using the
existing process-tree cleanup and its `exited.reason` diagnostics. A new open
cannot join a process whose shutdown has begun. A failed stop retains the
last lease for retry.

A native exit is recorded once by every attached session. Completed disposals
receive no later exit. Exit also attempts each session's hosted-terminal
cleanup and reports any failure. Resource readings are the whole shared
process with `scope: "shared_process"`; unsupported or unavailable readings
remain null, never an invented per-session share.

## Credentials

Every shared record and connection diagnostic uses the union of explicit
credentials from every lease ever attached to that process, including released
and disposed leases. Native work may retain those credentials after its owner
leaves. Only redactors, not disposed session targets, are retained for this
purpose. The known values are combined first, deduplicated and replaced
longest first, so one lease's shorter credential cannot expose a suffix of
another lease's longer credential. The sorted union is cached and recomputed
only after a lease joins or its credential set gains a distinct value. Session records use that union directly,
without a preceding session-only replacement. It also protects errors and
retained stderr through final cleanup.
No inherited environment or credential file is scanned for additional secrets.

Known credentials and token-shaped strings are hidden before shared native
notifications can reach SDK diagnostic logging. Actual host-request parameters
remain intact for terminal execution; their recorded copies pass through the
same union redactor. No raw shared stderr is inherited by the host console.
Pool configuration and keys are private and never put in records.

The synthetic process tests in `tests/acp/acp-shared-session.test.ts` cover
interleaved opens, replay, resume conflicts, independent cwd/MCP configuration,
permissions, late descendants, cross-root terminals, failed opens, release,
late completion, peer survival, process exit and retired credentials. Routing
capacity/expiry tests are in `tests/acp/acp-routing.test.ts`. These are
mechanism tests, not admission evidence for a native runtime.


## Record changes on both ACP paths

These are intentional observable changes to the isolated path as well as the
new shared factory, and must be listed in the release notes:

- ACP `session/update` records now preserve vendor extra fields from the raw
  validated parameters. They no longer store a schema-parsed copy or insert
  SDK defaults for omitted fields. Projection and live/replay folds continue
  to tolerate omitted optional fields.
- Permission and terminal requests from a native child, and their answers,
  now retain that child's session id rather than the root's id.

Native exit also attempts hosted-terminal cleanup. A failure produces an
explicit failed `cleanup` response with empty request id, in addition to the
actual `exited` response. This reports an OAR cleanup observation, not a new
native frame or a successful stop. A host request cancelled before handler
dispatch remains a `toApp` request and an answered failure; no terminal or
other host work starts for the cancelled request.

OpenCode production admission is closed on every platform and version,
including 2.2.3 and 2.2.5: configured plugins can start child processes in
HOME when shared and in the session directory when isolated. Because these
plugins cannot be determined from SessionOptions, `auto` must fall back to
isolation before starting a shared process, and explicit `shared` must fail
with `UnsupportedOptionError` for `placement`. See the
[native evidence](../../experiments/sharing/opencode-plugin-environment-2026-10-31.md).

The disabled candidate's running process must confirm exact 2.2.3 or 2.2.5
in its initialize reply before any session/new or resume. A stale installation
snapshot cannot admit a newer binary. Version refusal retires the pool entry
and stops its process before auto opens independently or shared is refused.
Directory canonicalization is ownership-only; native and isolated fallback
opens retain the caller's cwd spelling. A directory-refused auto open waits
for shared initialization to settle, but does not inherit its failure.
