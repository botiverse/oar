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

The official SDK registers a unique outgoing request id before writing it.
Replies resolve that operation, never the most recently opened session.
Initialization failures end that pool entry and reject its waiting opens.
Opening or configuring one session fails only that open and cleans its
explicitly acquired native id. No already-open peer is restarted or replayed.
The connection's initialize reply is not a root session frame.

Reserve a resume/load id before sending the request. For a new session, bind
only the id in its successful native response. An id already controlled,
released, closing or retired on this connection cannot be taken over:
`UnsupportedOptionError` rejects resume. Retired ids remain unavailable for
the connection's lifetime because ACP does not prove a generation boundary
that would distinguish late old traffic from a new controller.

## Routing and buffering

Route native updates and host requests by an explicitly owned root or a
vendor-proven descendant link. Runtime adapters supply the native association
reader. Unknown ids do not become children merely because they share a
connection. Transitive links may arrive after a child's update.

The connection retains at most 256 unowned frames, one MiB of their encoded
params, and one second of waiting by default. Internal vendor configuration
may set those bounds. Matching ownership flushes buffered frames in original
arrival order. Records retain the transport's original `receivedAt`, even
when binding or SDK dispatch happens later; sequence numbers remain dense
append order. Opening replay and live usage are distinguished at the native
open response boundary before asynchronous SDK dispatch.

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
purpose. They also protect errors and retained stderr through final cleanup.
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
