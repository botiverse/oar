# Root identity options before any implementation

Keep the current behavior until ownership can be established independently of
wall-clock ordering. A failed cleanup read remains unverified; a spontaneous
exit before any OAR stop action keeps its native result and the documented
natural-exit cleanup limitation. This comparison does not propose adding a
native dependency in the current patch.

Cindy's task #132 decision is that time intervals can be auxiliary evidence,
never independent authorization to signal a process. The counterexample in
`synthetic-counterexamples.json` needs no assumptions about the size of a clock
jump: a rollback and restoration between discrete samples defeats the proposed
offset check.

Holding a handle prevents **later** reuse of that process object's PID. It does
not remove children left by a **previous** owner of that number. A rollback
before the new root's creation can make one of those older children have a
later creation timestamp. Comparing those timestamps still uses clock ordering.
The read-only experiment includes this second synthetic counterexample. No
clock-independent descendant attribution proof has been established here.

| Option | Dependencies and shipped size | Per owned runtime process | Windows coverage and remaining gap |
| --- | --- | --- | --- |
| Current behavior | No new dependency; zero added package bytes | No retained native handle or helper | Existing platform behavior. Early natural exit can leave descendants unobserved; preserve that limitation rather than guess ownership. |
| Node-API addon opening and retaining a root handle | New compiled addon and build/release pipeline; prebuilt x64 and arm64 artifacts needed. Binary bytes are unmeasured, not estimated from source size. | At least one retained kernel handle per owned process; no extra OS process. Memory and call cost need a prototype. | Both architectures need tests. Access to Node's private child handle is not a stable Node-API feature; opening by PID instead needs a proven acquisition boundary and identity check. |
| Persistent native helper shared by the host | New executable, IPC protocol, build/signing/package lifecycle. Separate architecture artifacts unless an explicitly tested emulation policy is chosen; bytes unmeasured. | One helper process per host plus one retained root handle per owned process; startup amortized across roots. CPU/RSS/IPC latency are unmeasured. | x64 and arm64 need native builds and validation. A fast root may exit before an asynchronous helper acquires its handle. A helper crash loses all pins. |
| One helper process per root | Same executable/build requirements | One extra OS process and at least one root handle per owned process | Same acquisition problem, with startup and RSS paid for every root. No basis yet for calling this cost acceptable. |
| PowerShell plus Add-Type research helper | Uses installed PowerShell and its compiler/runtime. Only source is added to this experiment; this is not a packaged native executable. | The current probe starts a temporary query process and closes its handles before returning; it does **not** implement a persistent pin. | This run targets Windows x64 only. It records shell startup/compile/query time, working set, CPU and handles. These are observer costs, not measurements of a future resident helper. ARM64 remains untested. |

Counts are architectural minimums, not performance measurements. Payload size,
RSS and startup numbers for unbuilt options remain missing. A future approved
prototype should report actual compressed and installed artifact sizes, cold
and warm acquisition latency, one and twenty simultaneous roots, helper crash
behavior, cleanup release, and both Windows architectures before a dependency
is selected. This experiment's one Windows x64 job cannot establish those facts.

The acquisition sequence must open the handle and inspect **that handle's**
identity before accepting it. Reading a PID's timestamp first and opening later
leaves a check/open race. Even opening first requires a trusted identity of the
original spawned process to compare against. Node's synchronous spawn/exit
boundary is an implementation-specific possibility under investigation, not a
public guarantee. No match means no claim. Pinning intermediate parents, or a
kernel-owned process grouping established at creation, would be separate
designs; neither is silently added to this proposal.

Node documents [Node-API ABI stability](https://nodejs.org/download/release/v24.19.0/docs/api/n-api.html#implications-of-abi-stability)
for its supported API, while private Node, V8 and libuv APIs are outside that
guarantee. Its [Node 24 platform table](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md#platform-list)
lists Windows x64 and arm64; no x86 coverage is claimed here. Microsoft documents
[OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess)
and [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
as handle-based queries. The latter returns creation and exit points in time,
not an ancestry token or a monotonic birth sequence.
