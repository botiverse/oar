# Factory droid: native stream-jsonrpc and ACP sign-in, before the first adapter

Date: 2026-11-15. droid 1.12.1 (protocol 1.340.0), Linux arm64, the official
release binary checked against its published SHA-256. No Factory account and no
key: every model turn ran against a custom (BYOK) model in an isolated HOME,
served by aimock. These results fixed the design of
[the Factory runtime](../../docs/runtimes/factory.md).

Run: `node experiments/factory-droid/probe.mjs [path/to/droid]`. It prints one
JSON object with the scenarios below.

## Results

| Question | Result |
|---|---|
| Does `droid exec` run whole turns without a Factory login? | Yes, with a `customModels` entry in `~/.factory/settings.json` (`provider: "generic-chat-completion-api"`). Its id is `custom:<displayName>-<index>`. Without a login, a turn on a Factory model ends `model_authentication_failed`, with droid's notice "Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable." So `droid exec` also uses a stored interactive login, not only the key. |
| When does `add_user_message` answer? | At once, with `{}`, before any turn event. The turn's end is the `agent_turn_completed` notification whose `turnId` is the message's `messageId`. |
| What does a second `add_user_message` during a turn do? | It is queued as `end_of_turn` (`queued_messages_changed`), drained into the running turn after the model's current step, echoed as a user `create_message` under its own `messageId`, and sent to the model in the same loop. The turn ends once, under the first message's `turnId`. This is native steering. |
| What does `interrupt_session` do to it? | It answers `{}`; queued steering not yet drained is discarded with `queued_messages_discarded`, whose `drainedRequestIds` name the JSON-RPC ids of those `add_user_message` requests; the turn ends `cancelled`. |
| Does a session resume in a new process? | Yes: `load_session { sessionId }` returns `settings`, `cwd`, `tokenUsage` and more, and the next turn runs. An unknown id answers `-32004 "Session not found"`. |
| Permissions under stream-jsonrpc? | Default autonomy is `medium`: a high-impact command sends `droid.request_permission` with options `proceed_once`, `proceed_always`, `cancel`. `skipPermissionsUnsafe: true` on `initialize_session` sends none. `load_session` takes no such flag and the resumed session asks again. |
| Model and effort | `list_models` answers before any session, without a login, and includes custom models with their `supportedReasoningEfforts`. An unknown `modelId` falls back to droid's default (`gpt-6.1-sol`) without an error; an effort the model does not list is clamped (`high` on a `none`-only model reads back `none`); an effort outside droid's enum is a `-32602` error. |
| Manual compaction | `compact_session {}` after two turns: `session_compacted { summaryId, removedCount }`, then `{ newSessionId, removedCount }` with `newSessionId` equal to the session id; a later `load_session` of that id holds the compacted history. During a turn: `-32602 "Wait for the current turn to finish before compacting."`. Empty conversation: `-32602 "Nothing to compact"`. |
| Context | `get_context_stats` answers `{ used, remaining, limit, accuracy, updatedAt }`. |

Further observations behind the adapter:

- MCP: a stdio server given on `initialize_session` connects, and the model
  reaches its tools as `<server>___<tool>` (offered through droid's
  `ToolSearch`, callable directly). `initialize_session`'s answer echoes the
  servers, `env` included, so OAR's records rely on credential redaction.
- Provider failures: a scripted 401 produced an `error` notification ("401
  Invalid synthetic key") and `agent_turn_completed.reason`
  `model_authentication_failed`.
- Tokens: `agent_turn_completed.tokenUsage` is per turn (it includes droid's
  title request on a session's first message); `session_token_usage_changed`
  carries the session's total across processes. `inputTokens` excludes the
  cache parts droid reports beside it.
- Usage limits: `droid exec` has no slash commands (`list_commands` is empty)
  and no account or limits method; the interactive UI reads
  `GET /api/billing/limits` over HTTP, which OAR's `accountUsage` reads the
  same way (request, credential storage and answer shape from droid's bundle;
  no account has answered it yet).

## Sign-in entry (no account used)

`droid exec --output-format acp` advertises `authMethods` `device-pairing` and
`factory-api-key` and `agentCapabilities.auth { logout, status }`.
`auth/status` answers `{ state: "unauthenticated" }`, and with any
`FACTORY_API_KEY` set `{ state: "authenticated", accounts: [{ label: "Factory
API key", active: true }] }` without checking the key. With
`clientCapabilities.elicitation.url`, `authenticate { methodId:
"device-pairing" }` sends `elicitation/create { mode: "url", url }`, Factory's
device page with the pairing code in it. A decline ends the authenticate with
`-32000 "Authentication required: Sign-in was cancelled."`. OAR's login was
driven up to that URL and cancelled; a completed sign-in still needs a real
account.
