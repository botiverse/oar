/**
 * Runtime→app requests a person decides: what oar read out of one (`AppAsk`,
 * carried on the `toApp` request record and its `app_request` event), the
 * decision `Session.answer` takes (`AppDecision`), and whether a runtime can
 * route its permission gate to the host at all (`ApprovalsCapability`).
 * Semantics: docs/spec/approvals.md; the record shapes they ride on are in
 * ./records.ts.
 */

/** A decision `Session.answer` takes, when the request's `AppAsk.choices` lists it. */
export type AskChoice =
  /** Let the gated action run, once. */
  | "allow"
  /** Let it run and let the runtime remember the grant for the rest of this session (claude: its own rule suggestion, kept to the session; codex `acceptForSession`). */
  | "allow_session"
  /** Refuse it; the turn goes on and the model is told. */
  | "deny"
  /** Answer the questions of a `question` ask. */
  | "answer";

/** One question of a `question` ask. */
export interface AskQuestion {
  /** The key its answer goes under in an `answer` decision: claude keys answers by the question text, codex by the question id. */
  readonly id: string;
  readonly question: string;
  /** The runtime's short label for the question, when it gives one. */
  readonly header?: string;
  /** The choices offered, in the runtime's order; empty when the question takes free text only. */
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  /** More than one option may be chosen. */
  readonly multiSelect: boolean;
  /** A free-text answer outside the options is taken (codex `isOther`; claude takes one on every question). */
  readonly other: boolean;
}

/**
 * What a runtime→app request asks, as oar read it out of the native body,
 * which stays verbatim beside it (`RequestBody.native`). Absent when oar
 * reads no decision a person could make from it (a terminal request, an MCP
 * elicitation form, a token refresh): the request is still recorded, and
 * `Session.answer` still takes a native reply for it.
 */
export type AppAsk =
  | {
      /** The runtime's permission gate asks whether a tool call may run. */
      readonly kind: "tool_approval";
      /** The runtime's name for the tool: claude `tool_name` (`Bash`, `Edit`, `mcp__…`), codex `commandExecution` / `fileChange`, an ACP tool call's `kind` (else its title). */
      readonly tool: string;
      /** The tool call the approval gates, when the runtime names it: the `callId` of its `tool_call_started` (claude `tool_use_id`, codex `itemId`, ACP `toolCallId`). */
      readonly callId?: string;
      /** The runtime's one-line description of the action (claude `title` or the tool's `description`, an ACP tool call `title`). */
      readonly title?: string;
      /** Why the runtime asks, in its words (claude `decision_reason`, codex `reason`). */
      readonly reason?: string;
      /** The tool input as the runtime sent it, JSON-encoded (claude `input`, ACP `rawInput`). */
      readonly input?: string;
      /** The command line that would run, verbatim (claude Bash `input.command`, codex `command`, ACP `rawInput.command`). */
      readonly command?: string;
      /** The directory the command would run in, when the runtime says. */
      readonly cwd?: string;
      /** Files the action touches, when the runtime names them (claude `blocked_path` / `input.file_path`, codex file-change paths, ACP `locations`). */
      readonly paths?: readonly string[];
      /** The change as a diff, when the runtime carries one (codex file changes); never computed by oar. */
      readonly diff?: string;
      readonly choices: readonly AskChoice[];
      /** A `deny` decision's `message` reaches the model (claude). Elsewhere a message is refused `unsupported`. */
      readonly denyMessage: boolean;
    }
  | {
      /** The agent asks the person questions (claude `AskUserQuestion`, codex `item/tool/requestUserInput`). */
      readonly kind: "question";
      readonly questions: readonly AskQuestion[];
      readonly choices: readonly AskChoice[];
      readonly denyMessage: boolean;
    };

/**
 * A host's decision on a runtime→app request (`Session.answer`). The typed
 * kinds are taken where the request's `AppAsk.choices` lists them; `native`
 * is the escape hatch for what oar has no word for.
 */
export type AppDecision =
  /** Let the action run: once (the default), or `session` to also let the runtime remember the grant for this session (`allow_session`). */
  | { readonly kind: "allow"; readonly scope?: "once" | "session" }
  /** Refuse it; the turn goes on. `message` is the reason the model reads, where the ask says `denyMessage`. */
  | { readonly kind: "deny"; readonly message?: string }
  /** Answer a `question` ask: per question id, the chosen option label(s) or free text. */
  | { readonly kind: "answer"; readonly answers: Readonly<Record<string, string | readonly string[]>> }
  /** Send the runtime's own reply payload verbatim (claude's `can_use_tool` answer, codex's JSON-RPC result, an ACP `RequestPermissionResponse`): a codex `cancel`, an ACP `allow_always` option, claude's `updatedInput`. */
  | { readonly kind: "native"; readonly native: unknown };

/**
 * `supported`: the runtime has a permission gate oar routes to the host.
 * `unsupported`: `code` says why in one word, `reason` in prose; a session
 * asked to open with `approvals: "ask"` rejects with that reason.
 */
export type ApprovalsCapability =
  | { readonly kind: "supported" }
  /**
   * `no_gate`: the runtime has no permission gate of its own to turn on (pi).
   * `not_enforceable`: it has one, but oar cannot turn it on for certain
   * through the selected interface, nor read which mode is in effect (grok:
   * a user's `permission_mode = "always-approve"` config outranks every
   * per-process and per-session switch).
   */
  | { readonly kind: "unsupported"; readonly code: "no_gate" | "not_enforceable"; readonly reason: string };
