import type { RpcResponse, RpcSessionState, SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { piRpcClone } from "../../packages/oar/src/runtimes/pi/rpc/open.js";
import { piForkPlan, piForkReceipt, piRpcForkThrough, piRpcNameCopy, type PiForkSource } from "../../packages/oar/src/runtimes/pi/rpc/fork.js";
import { foldPiEvent, initialPiProjection, piPrompted } from "../../packages/oar/src/runtimes/pi/projection.js";

type Control = Parameters<typeof piRpcClone>[0];

const state = (sessionId: string, sessionName?: string): RpcSessionState => ({
  sessionId,
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 1,
  pendingMessageCount: 0,
  ...(sessionName === undefined ? {} : { sessionName }),
});

function control(...responses: RpcResponse[]): Control {
  let index = 0;
  return {
    request: async () => {
      const response = responses[index++];
      if (response === undefined) { throw new Error("unexpected RPC request"); }
      return response;
    },
  };
}

/** A control answering by command type from queued replies, recording the order it was asked in. */
function dispatch(answers: Readonly<Record<string, readonly RpcResponse[]>>): Control & { readonly asked: string[] } {
  const asked: string[] = [];
  const used = new Map<string, number>();
  return {
    asked,
    request: async (command) => {
      asked.push(command.type);
      const index = used.get(command.type) ?? 0;
      used.set(command.type, index + 1);
      const response = answers[command.type]?.[index];
      if (response === undefined) { throw new Error(`unexpected RPC request ${command.type} #${String(index)}`); }
      return response;
    },
  };
}

const cloneOk = (cancelled: boolean): RpcResponse => ({ id: "clone", type: "response", command: "clone", success: true, data: { cancelled } });
const forkOk = (cancelled: boolean): RpcResponse => ({ id: "fork", type: "response", command: "fork", success: true, data: { text: "hi", cancelled } });
const stateOk = (sessionId: string, sessionName?: string): RpcResponse => ({ id: "state", type: "response", command: "get_state", success: true, data: state(sessionId, sessionName) });
const entriesOk = (source: PiForkSource): RpcResponse => ({ id: "entries", type: "response", command: "get_entries", success: true, data: { entries: [...source.entries], leafId: source.leafId } });
const namedOk = (): RpcResponse => ({ id: "name", type: "response", command: "set_session_name", success: true });

const user = (id: string, parentId: string | null): SessionEntry => ({ type: "message", id, parentId, timestamp: "t", message: { role: "user", content: id, timestamp: 0 } });
const custom = (id: string, parentId: string | null): SessionEntry => ({ type: "custom", id, parentId, timestamp: "t", customType: "probe" });
const label = (id: string, parentId: string | null, targetId: string): SessionEntry => ({ type: "label", id, parentId, timestamp: "t", targetId, label: "kept" });

/**
 * Two settled turns in the shape the RPC child reports: model_change → u1 → a1
 * → u2 → a2, where the non-user entries stand in for the assistant messages a
 * turn appends (the plan treats every non-user entry as opaque).
 */
const root: SessionEntry = { type: "model_change", id: "m", parentId: null, timestamp: "t", provider: "aimock", modelId: "aimock-model" };
const source: PiForkSource = {
  entries: [root, user("u1", "m"), custom("a1", "u1"), user("u2", "a1"), custom("a2", "u2")],
  leafId: "a2",
};
/** The copy `through: a1` must produce: turn 1 only. */
const firstTurnOnly: PiForkSource = { entries: source.entries.slice(0, 3), leafId: "a1" };

test("native clone requires a non-cancelled response and a new read-back id", async () => {
  const copied = piRpcClone(control(cloneOk(false), stateOk("copy")), "source");
  await expect(copied).resolves.toMatchObject({ sessionId: "copy" });
  const cancelled = piRpcClone(control(cloneOk(true)), "source");
  await expect(cancelled).rejects.toThrow("clone was cancelled");
  const sameId = piRpcClone(control(cloneOk(false), stateOk("source")), "source");
  await expect(sameId).rejects.toThrow("kept the source session id");
  const noId = piRpcClone(control(cloneOk(false), stateOk("  ")), "source");
  await expect(noId).rejects.toThrow("returned no session id");
});

test("a native clone failure is not converted into a session", async () => {
  const failed = piRpcClone(control({ id: "clone", type: "response", command: "clone", success: false, error: "native refused" }), "source");
  await expect(failed).rejects.toThrow("Pi RPC clone failed: native refused");
});

// Pi's `fork { entryId }` copies the path BEFORE a user message, so the copy
// that keeps turn 1 is a fork before the message that opens turn 2.
test("an anchor mid-conversation forks before the user message that opens the next turn", () => {
  expect(piForkPlan(source, "a1")).toEqual({ kind: "fork", entryId: "u2", kept: ["m", "u1", "a1"] });
  // The start of the last turn is still a cut: nothing follows it but its own turn.
  expect(piForkPlan(source, "u2")).toEqual({ kind: "clone", kept: ["m", "u1", "a1", "u2", "a2"] });
  // The last turn's anchor copies the whole conversation.
  expect(piForkPlan(source, "a2")).toEqual({ kind: "clone", kept: ["m", "u1", "a1", "u2", "a2"] });
});

test("an anchor the source does not hold, or one off the copied branch, is refused", () => {
  expect(() => piForkPlan(source, "nope")).toThrow("Pi session has no entry nope to fork through");
  const abandoned: PiForkSource = { entries: [...source.entries, user("u9", "a1")], leafId: "a2" };
  expect(() => piForkPlan(abandoned, "u9")).toThrow("is not on the session's current path");
  expect(() => piForkPlan({ entries: [], leafId: null }, "a1")).toThrow("has no current entry to copy");
  const broken: PiForkSource = { entries: [user("u1", "gone")], leafId: "u1" };
  expect(() => piForkPlan(broken, "u1")).toThrow("is not in the session's own entry list");
});

test("a copy is accepted only when it holds the anchor and no later message", () => {
  const kept = ["m", "u1", "a1"];
  expect(() => { piForkReceipt(firstTurnOnly, "a1", kept); }).not.toThrow();
  // Pi re-creates label entries under fresh ids; they are bookmarks, not turns.
  const relabelled: PiForkSource = { entries: [...firstTurnOnly.entries, label("fresh", "a1", "u1")], leafId: "fresh" };
  expect(() => { piForkReceipt(relabelled, "a1", kept); }).not.toThrow();
  expect(() => { piForkReceipt({ entries: source.entries.slice(0, 1), leafId: "m" }, "a1", kept); }).toThrow("without the anchor a1");
  expect(() => { piForkReceipt(source, "a1", kept); }).toThrow("past the anchor a1: the copy holds 1 message(s) the source has after it");
});

test("fork.through runs Pi's own fork and proves the copy is cut at the anchor", async () => {
  const rpc = dispatch({ get_entries: [entriesOk(source), entriesOk(firstTurnOnly)], fork: [forkOk(false)], get_state: [stateOk("copy")] });
  await expect(piRpcForkThrough(rpc, "source", "a1")).resolves.toMatchObject({ sessionId: "copy" });
  expect(rpc.asked).toEqual(["get_entries", "fork", "get_state", "get_entries"]);
});

test("an anchor on the last turn clones instead, and is still verified", async () => {
  const rpc = dispatch({ get_entries: [entriesOk(source), entriesOk(source)], clone: [cloneOk(false)], get_state: [stateOk("copy")] });
  await expect(piRpcForkThrough(rpc, "source", "a2")).resolves.toMatchObject({ sessionId: "copy" });
  expect(rpc.asked).toEqual(["get_entries", "clone", "get_state", "get_entries"]);
});

test("a cancelled or refused copy never becomes a session", async () => {
  const cancelled = dispatch({ get_entries: [entriesOk(source)], fork: [forkOk(true)] });
  await expect(piRpcForkThrough(cancelled, "source", "a1")).rejects.toThrow("fork was cancelled; the new session id was not confirmed");
  const cancelledClone = dispatch({ get_entries: [entriesOk(source)], clone: [cloneOk(true)] });
  await expect(piRpcForkThrough(cancelledClone, "source", "a2")).rejects.toThrow("clone was cancelled");
  const refused = dispatch({ get_entries: [entriesOk(source)], fork: [{ id: "fork", type: "response", command: "fork", success: false, error: "native refused" }] });
  await expect(piRpcForkThrough(refused, "source", "a1")).rejects.toThrow("Pi RPC fork failed: native refused");
  const noSession = dispatch({ get_entries: [{ id: "entries", type: "response", command: "get_entries", success: false, error: "no session" }] });
  await expect(piRpcForkThrough(noSession, "source", "a1")).rejects.toThrow("Pi RPC get_entries failed: no session");
});

test("an ambiguous or unfaithful copy never becomes a session", async () => {
  const sameId = dispatch({ get_entries: [entriesOk(source)], fork: [forkOk(false)], get_state: [stateOk("source")] });
  await expect(piRpcForkThrough(sameId, "source", "a1")).rejects.toThrow("kept the source session id source");
  const empty = dispatch({ get_entries: [entriesOk(source)], fork: [forkOk(false)], get_state: [stateOk("  ")] });
  await expect(piRpcForkThrough(empty, "source", "a1")).rejects.toThrow("returned no session id");
  const wholeCopy = dispatch({ get_entries: [entriesOk(source), entriesOk(source)], fork: [forkOk(false)], get_state: [stateOk("copy")] });
  await expect(piRpcForkThrough(wholeCopy, "source", "a1")).rejects.toThrow("past the anchor a1");
  const noAnchor = dispatch({ get_entries: [entriesOk(source), entriesOk({ entries: source.entries.slice(0, 2), leafId: "u1" })], fork: [forkOk(false)], get_state: [stateOk("copy")] });
  await expect(piRpcForkThrough(noAnchor, "source", "a1")).rejects.toThrow("without the anchor a1");
});

test("a failed copy reply is never read as the state of a fork", async () => {
  const wrongCommand = dispatch({ get_entries: [entriesOk(source)], fork: [{ id: "fork", type: "response", command: "clone", success: true, data: { cancelled: false } }] });
  await expect(piRpcForkThrough(wrongCommand, "source", "a1")).rejects.toThrow("replied to a different command while forking");
});

// Pi's `--name` flag names the session the child OPENS, which on a fork is the
// source; the copy is named natively once it exists, and read back.
test("a forked copy is named through the child's own session name, read back", async () => {
  const rpc = dispatch({ set_session_name: [namedOk()], get_state: [stateOk("copy", "copy name")] });
  await expect(piRpcNameCopy(rpc, "copy name")).resolves.toMatchObject({ sessionId: "copy", sessionName: "copy name" });
  expect(rpc.asked).toEqual(["set_session_name", "get_state"]);
  const refused = dispatch({ set_session_name: [{ id: "name", type: "response", command: "set_session_name", success: false, error: "no session" }] });
  await expect(piRpcNameCopy(refused, "copy name")).rejects.toThrow("Pi RPC set_session_name failed: no session");
  const ignored = dispatch({ set_session_name: [namedOk()], get_state: [stateOk("copy", "someone else")] });
  await expect(piRpcNameCopy(ignored, "copy name")).rejects.toThrow('Pi did not name the forked session "copy name"');
});

// SessionOptions.fork.through takes the anchor of a root turn_ended, so the
// fold names one only when the adapter read a native leaf for that turn.
test("a settled turn hands the adapter's native leaf to turn_ended as its fork anchor", () => {
  const running = piPrompted(initialPiProjection);
  const settled = (anchor?: string) => {
    const { commands } = foldPiEvent(running, { type: "agent_settled", aborted: false }, anchor === undefined ? {} : { forkAnchor: anchor });
    const events = commands[0]?.kind === "frame" ? commands[0].body.events : [];
    return events.flatMap((event) => event.kind === "turn_ended" ? [event] : []);
  };
  expect(settled("leaf-entry")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" }, forkAnchor: "leaf-entry" }]);
  expect(settled()).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
});
