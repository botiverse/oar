# OAR Arena

Two coding agents duel; a browser watches. Claude Code vs Codex by default, but
a fighter is just an oar runtime id, so any two installed runtimes can fight.

```bash
pnpm arena                                         # claude vs codex, http://localhost:4747
pnpm arena --left claude:haiku --right codex       # runtime[:model]
pnpm arena --left grok --right kimi
pnpm arena --left mock:claude --right mock:codex   # no real turns: work on the stage for free
```

Flags: `--port`, `--timeout <seconds per move>`, `--pace <ms between rounds>`,
`--taunt-language`.

## The game

Both fighters start with 100 HP and 2 tokens, and earn a token a round. Each
round both pick one move **in secret**: `patch`, `refactor`, `rm_rf`,
`sandbox`, `compact`, `think`, `inject` (costs and effects are on the start
screen, read from `game.ts`). Whoever **answered faster** resolves first, so
real model latency is the speed stat. An illegal answer is a hallucination: no
effect, 5 self-damage. Knockout wins; after 20 rounds the higher HP does.

The crowd can shout at a fighter while it thinks (the box under its panel).
That is `session.steer()`: the line lands inside the active turn. A runtime
that cannot steer has no `session.steer`, and its fighter ignores the crowd.

## How it uses oar

| Piece | oar surface |
| --- | --- |
| One fighter, any vendor | `allRuntimes.require(id)` → `installation()` → `session()` |
| Rules survive compaction | `SessionOptions.systemPrompt` |
| A move | `promptAndWait()`: the turn's outcome and its text in one call |
| Thinking aloud, live | `session.events()`: `text_delta`, `reasoning`, `tool_call_started` |
| Too slow | `promptAndWait({ timeoutMs })` aborts and reports `interrupted` |
| Heckling | `session.steer()` where the session has one; a shout that became a turn of its own is waited out with `awaitIdle()` |
| Panel header | `session.model()`, `session.usage()`, `session.contextUsage()` |
| Fighter portrait | `runtime.brand` |

Each fighter is ONE session for the whole match, so it remembers how its
opponent plays. `fighters.ts` is the only file that knows oar exists;
`game.ts` is a pure referee (unit-tested in `tests/arena-game.test.ts`).

Sessions run YOLO, as everywhere in oar. Fighters are told not to use tools
and get an empty temp directory as cwd; the server listens on loopback only.
A match spends real turns on both accounts: about 20 short turns each at most.
