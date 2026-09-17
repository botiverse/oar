# Dirty work vs foundations

oar wants to lay a solid foundation for the application layer, not just be a
nice adapter. That requires knowing which problems from
[hard-problems.md](hard-problems.md) are which. The dividing test:

> **Can a mistake here be fixed later without breaking what's built on top?**

## Dirty work: mistakes stay local

Install, detect, auth, OS quirks, config forms. This work is stateless: if we
get it wrong, we fix the bug and nothing downstream has to change. It is
valuable to have solved (it's most of the visible surface), but any mistake
stays local. Dirty work just needs to be *done*.

## Foundations: mistakes bake into consumers' data models

These are the problems where a wrong early decision gets encoded into the
application's own data model and then compounds. Foundation decisions need to
be *right*:

- **Losslessness.** If the producer drops or synthesizes events, the data is
  simply gone or fake; no later fix recovers it. This is why "never
  fabricate" is a red line, not a preference.
- **Session identity, graph, and cursor.** Applications build persistence
  and resume on top of these. Change what "a session" means later and every
  consumer's stored history breaks.
- **Attribution: sub-agent and usage.** Billing and observability get built
  on it; if it's wrong, the recorded history is wrong forever (grok's
  unsummable overlapping usage views show how easy wrong is).
- **Fact vs control separation.** If status/control leaks into the fact
  stream, consumers encode assumptions that can never be unwound. Status
  must stay a derivation, a fold over events, not a parallel channel.
- **Capability honesty.** If we silently fake support, application logic
  gets written against lies, and the correction is a breaking change for
  *consumers*, not for us. Weak runtimes return typed `unsupported`; absent
  knowledge is declared unknown, never guessed.

Stability (knowing whether an agent is alive or dead, and why) is also a
foundation problem; it gets its own page: [liveness.md](liveness.md).

## System coherence

The foundations compose into a control loop. The agent-facing system is
described in [system.md](system.md): discover, declare, control, record,
project, and continue. Each layer has one owner and one dependency direction.
This prevents a projection from becoming an unrecorded source of truth, an
adapter from assuming host policy, or a resume token from being mistaken for
replay.

For a new surface, ask whether it makes the loop more legible: can an agent
orient, act, observe, verify, checkpoint, and hand off with less guessing and
less duplicated work? If not, keep it in a host experiment.

## Replay boundary

**Resume** asks a runtime to restore model context from its own persisted
material. **Replay** redelivers OAR records to an observer. OAR's replay source
is its own ordered record stream: requests, responses, and native frames.
Native session history may help resume or diagnose a session, but it does not
substitute for the OAR stream, which also contains host control attempts and
rejections that the runtime never saw.

This is an OAR contract boundary, not a claim that native live replay is
impossible. The investigated runtimes persist some content at a coarser grain
than they emit it, so their history cannot reconstruct every live delta.
Another runtime could persist every notification and provide a replay cursor;
that capability would need its own evidence and mapping. A history pagination
cursor alone does not establish this guarantee.

The library currently retains records in memory for a Session instance. A host
that needs replay after restart must persist records before delivering them,
retain stream-instance identity when sequence numbers restart, and define its
own durability policy. Native resume does not recover the host's lost log.
See [the record stream](../spec/record-stream.md) and
[conversation projection](../spec/conversation.md) for the concrete APIs.

**Session, turn, and connection have distinct lifecycles.** A turn on a shared
server may outlive its initiating connection; a locally spawned harness may
stop when its owning process exits. Connection identity may be absent,
implicit, or explicitly addressable. Those are runtime facts to probe, not
universal ownership rules. OAR keeps reported native identifiers as evidence;
a self-reported originator or client-supplied ID is not proof of authority.

Two comparisons remain useful across runtimes:

- **Connection identity and cursor are independent.** A connection ID does
  not imply replay, and a replay cursor does not imply an addressable
  connection. Record both facts separately.
- **Identity authority and uniqueness scope are independent.** Record who
  supplies an ID, who validates it, and where it is unique. A server-minted
  date counter can be host-local; a client-supplied UUID can be globally
  collision-resistant without proving ownership. Authorization must come from
  the runtime or host's access-control contract, not from the ID's shape.

## Adapter vs foundation

An adapter is judged by how much it covers today; a foundation is judged by
what it makes impossible to get wrong later. This is why the design
discipline applies specifically to the foundation list: every design point
must state its necessity with empirical evidence (a real runtime that breaks
without it), not taste.
