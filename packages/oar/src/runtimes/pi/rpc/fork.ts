import type { RpcSessionState, SessionEntry } from "@earendil-works/pi-coding-agent";
import { piRpcState, type PiRpcControl } from "./control.js";

/**
 * What one `SessionOptions.fork.through` anchor means to Pi's own RPC
 * commands, computed from the session the child reports.
 *
 * Pi 1.6 has two copying commands and neither takes a cut position:
 * `fork { entryId }` copies only the path BEFORE the user message named
 * (`agent-session-runtime.js`, `fork(entryId, { position: "before" })`: the
 * new leaf is `selectedEntry.parentId`, and a non-user entry is refused with
 * "Invalid entry ID for forking"), and `clone` copies the path to the current
 * leaf (`{ position: "at" }`). A copy that holds the anchor's turn and no
 * later turn is therefore a fork before the NEXT user message of the branch,
 * or the whole branch when the anchor's turn is its last one.
 *
 * The anchor is the leaf entry id Pi reported at the end of the turn (the
 * RPC session reads it from the child's own `get_entries`), a real entry of
 * the source session: this module never invents, parses or normalises one.
 */
export interface PiForkSource {
  readonly entries: readonly SessionEntry[];
  readonly leafId: string | null;
}

/**
 * The native command that copies the source through `anchor`, plus `kept`,
 * the entry ids a faithful copy of that turn may hold. `kept` is the branch
 * Pi's own `getBranch(leafId)` returns, cut before the user message that
 * starts the next turn.
 */
export type PiForkPlan =
  | { readonly kind: "fork"; readonly entryId: string; readonly kept: readonly string[] }
  | { readonly kind: "clone"; readonly kept: readonly string[] };

function isUserMessage(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

/**
 * The entries the copy Pi would make start from, root first (Pi's own
 * `getBranch(leafId)`: the parent chain of the current leaf, which is the one
 * branch a fork or clone copies). A session with no leaf has nothing to copy;
 * an entry list that loses one of its own parents is not a session OAR can
 * reason about, so both fail closed rather than guess a branch.
 */
function branchPath(source: PiForkSource): readonly SessionEntry[] {
  if (source.leafId === null) {
    throw new Error("Pi cannot fork this session: it has no current entry to copy");
  }
  const byId = new Map(source.entries.map((entry) => [entry.id, entry] as const));
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let id: string | null = source.leafId;
  while (id !== null) {
    if (visited.has(id)) { throw new Error(`Pi session entry ${id} forms a parent cycle`); }
    visited.add(id);
    const entry = byId.get(id);
    if (entry === undefined) { throw new Error(`Pi session entry ${id} is not in the session's own entry list`); }
    path.push(entry);
    id = entry.parentId;
  }
  return path.toReversed();
}

/**
 * The copy plan for `anchor`. An anchor the source does not hold at all, or
 * one on an abandoned branch (which a fork would silently cut away), rejects:
 * `fork.through` names a turn of the conversation that is being copied.
 */
export function piForkPlan(source: PiForkSource, anchor: string): PiForkPlan {
  const path = branchPath(source);
  const cut = path.findIndex((entry) => entry.id === anchor);
  if (cut === -1) {
    throw new Error(source.entries.some((entry) => entry.id === anchor)
      ? `Pi fork anchor ${anchor} is not on the session's current path, which is the branch a fork copies`
      : `Pi session has no entry ${anchor} to fork through`);
  }
  const following = path.slice(cut + 1);
  const next = following.findIndex((entry) => isUserMessage(entry));
  if (next === -1) {
    return { kind: "clone", kept: path.map((entry) => entry.id) };
  }
  const start = following[next];
  if (start === undefined) { throw new Error(`Pi fork plan found no entry at ${String(next)}`); }
  return { kind: "fork", entryId: start.id, kept: path.slice(0, cut + 1 + next).map((entry) => entry.id) };
}

/**
 * The receipt a fork must produce before OAR exposes it: the copy holds the
 * anchor's turn and no message from a later one. Pi writes the copy into a
 * NEW session file (`SessionManager.createBranchedSession`, which re-creates
 * only `label` entries under new ids), so a copy failing this is not the copy
 * `through` promised and must not become a Session.
 */
export function piForkReceipt(copy: PiForkSource, anchor: string, kept: readonly string[]): void {
  const allowed = new Set(kept);
  if (!copy.entries.some((entry) => entry.id === anchor)) {
    throw new Error(`Pi forked a session without the anchor ${anchor}`);
  }
  const stray = copy.entries.filter((entry) => entry.type === "message" && !allowed.has(entry.id));
  if (stray.length > 0) {
    throw new Error(`Pi forked a session past the anchor ${anchor}: the copy holds ${String(stray.length)} message(s) the source has after it`);
  }
}

/** The entry list and current leaf the child reports from its own session manager. */
async function piRpcForkSource(control: PiRpcControl): Promise<PiForkSource> {
  const response = await control.request({ type: "get_entries" });
  if (!response.success) { throw new Error(`Pi RPC get_entries failed: ${response.error}`); }
  if (response.command !== "get_entries") { throw new Error("Pi replied to a different command while reading its entries"); }
  return response.data;
}

/**
 * `SessionOptions.fork.through` on Pi RPC: Pi's own `fork { entryId }` (cut
 * before a user message) or `clone` (cut at the leaf) copies the session
 * branch into a NEW session file, leaving the source file unmodified. Which
 * one, and where, comes from the entry list the CHILD reports, never from a
 * guess: `piForkPlan` refuses an anchor the source does not hold on its
 * current path, and `piForkReceipt` refuses a copy that holds a later turn.
 * A cancelled copy, a native refusal, an absent or unchanged id, and a copy
 * missing the anchor all fail closed before OAR exposes a Session.
 */
export async function piRpcForkThrough(control: PiRpcControl, sourceSessionId: string, anchor: string): Promise<RpcSessionState> {
  const plan = piForkPlan(await piRpcForkSource(control), anchor);
  if (plan.kind === "fork") {
    const forked = await control.request({ type: "fork", entryId: plan.entryId });
    if (!forked.success) { throw new Error(`Pi RPC fork failed: ${forked.error}`); }
    if (forked.command !== "fork") { throw new Error("Pi replied to a different command while forking"); }
    if (forked.data.cancelled) { throw new Error("Pi RPC fork was cancelled; the new session id was not confirmed"); }
  } else {
    const cloned = await control.request({ type: "clone" });
    if (!cloned.success) { throw new Error(`Pi RPC clone failed: ${cloned.error}`); }
    if (cloned.command !== "clone") { throw new Error("Pi replied to a different command while forking"); }
    if (cloned.data.cancelled) { throw new Error("Pi RPC clone was cancelled; the new session id was not confirmed"); }
  }
  const state = piRpcState(await control.request({ type: "get_state" }));
  if (state.sessionId.trim().length === 0) { throw new Error("Pi RPC fork returned no session id"); }
  if (state.sessionId === sourceSessionId) { throw new Error(`Pi RPC fork kept the source session id ${sourceSessionId}`); }
  piForkReceipt(await piRpcForkSource(control), anchor, plan.kept);
  return state;
}

/**
 * Name a session Pi has just replaced with a copy (`set_session_name`, then
 * the child's own report of it). Pi's `--name` startup flag names the session
 * the child OPENS, so passing it on a fork would name the SOURCE: measured on
 * the bundled 1.6.1 child, `fork: {}` with `name` appended the copy's
 * `session_info` to the source file (pinned by
 * sea-trial/vendor/pi-rpc-fork.vendor.test.ts).
 */
export async function piRpcNameCopy(control: PiRpcControl, name: string): Promise<RpcSessionState> {
  const named = await control.request({ type: "set_session_name", name });
  if (!named.success) { throw new Error(`Pi RPC set_session_name failed: ${named.error}`); }
  if (named.command !== "set_session_name") { throw new Error("Pi replied to a different command while naming the copy"); }
  const state = piRpcState(await control.request({ type: "get_state" }));
  if (state.sessionName !== name) { throw new Error(`Pi did not name the forked session ${JSON.stringify(name)}`); }
  return state;
}
