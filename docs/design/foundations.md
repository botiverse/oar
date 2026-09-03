# Dirty work vs foundations

oar wants to lay a solid foundation for the application layer, not just be a
nice adapter. That requires knowing which problems from
[hard-problems.md](hard-problems.md) are which. The dividing test:

> **Can a mistake here be fixed later without breaking what's built on top?**

## Dirty work: mistakes stay local

Install, detect, auth, OS quirks, config forms. This work is stateless: if we
get it wrong, we fix the bug and nothing downstream has to change. It is
valuable to have solved — it's most of the visible surface — but any mistake
stays local. Dirty work just needs to be *done*.

## Foundations: mistakes bake into consumers' data models

These are the problems where a wrong early decision gets encoded into the
application's own data model and then compounds. Foundation decisions need to
be *right*:

- **Losslessness.** If the producer drops or synthesizes events, the data is
  simply gone or fake — no later fix recovers it. This is why "never
  fabricate" is a red line, not a preference.
- **Session identity, graph, and cursor.** Applications build persistence
  and resume on top of these. Change what "a session" means later and every
  consumer's stored history breaks.
- **Attribution — sub-agent and usage.** Billing and observability get built
  on it; if it's wrong, the recorded history is wrong forever (grok's
  unsummable overlapping usage views show how easy wrong is).
- **Fact vs control separation.** If status/control leaks into the fact
  stream, consumers encode assumptions that can never be unwound. Status
  must stay a derivation — a fold over events — not a parallel channel.
- **Capability honesty.** If we silently fake support, application logic
  gets written against lies, and the correction is a breaking change for
  *consumers*, not for us. Weak runtimes return typed `unsupported`; absent
  knowledge is declared unknown, never guessed.

Stability — knowing whether an agent is alive or dead, and why — is also a
foundation problem; it gets its own page: [liveness.md](liveness.md).

## Adapter vs foundation

An adapter is judged by how much it covers today; a foundation is judged by
what it makes impossible to get wrong later. This is why the design
discipline applies specifically to the foundation list: every design point
must state its necessity with empirical evidence (a real runtime that breaks
without it), not taste.
