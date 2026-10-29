import type { AdapterGoalControl, GoalSetOptions, GoalSnapshot, KnownGoalStatus } from "../../contracts/goal.js";
import type { ControlResult, ResponseBody, RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { AppServerClient } from "./app-server-client.js";
import { rpcControl } from "./rpc-control.js";

const statuses: readonly KnownGoalStatus[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];

/** Only fields the native response actually carries, including unfamiliar status words. */
export function codexGoal(value: unknown): GoalSnapshot | null | undefined {
  if (value === null) { return null; }
  const goal = asRecord(value);
  if (typeof goal?.objective !== "string" || typeof goal.status !== "string") { return undefined; }
  const fields = Object.fromEntries(["tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"].flatMap((key) => {
    const number = goal[key];
    return typeof number === "number" && Number.isFinite(number) ? [[key, number]] : [];
  }));
  const budget = goal.tokenBudget;
  return { objective: goal.objective, status: goal.status, ...fields,
    ...(budget === null || (typeof budget === "number" && Number.isFinite(budget)) ? { tokenBudget: budget } : {}),
  };
}

export function codexGoalEvents(method: string, params: JsonRecord): RuntimeEventBody[] {
  if (method === "thread/goal/cleared") { return [{ kind: "goal_changed", goal: null }]; }
  if (method !== "thread/goal/updated") { return []; }
  const goal = codexGoal(params.goal);
  return goal === undefined ? [] : [{ kind: "goal_changed", goal }];
}

/** Confirm the typed enable option after unchecked host launch arguments were applied. */
export async function confirmCodexGoals(client: AppServerClient): Promise<void> {
  const reply = await client.request("config/read", { includeLayers: false });
  if (asRecord(asRecord(reply.config)?.features)?.goals !== true) {
    throw new Error("codex did not confirm goals enabled; check conflicting launchArgs or native policy");
  }
}

function unsupported(reason: string): ResponseBody {
  return { kind: "rejected", code: "unsupported", reason };
}

function setRefusal(options: GoalSetOptions): ResponseBody | null {
  if (Object.keys(options).some((key) => !["objective", "status", "tokenBudget"].includes(key))) {
    return unsupported("codex goal.set supports only objective, status and tokenBudget");
  }
  if (options.status !== undefined && !statuses.some((status) => status === options.status)) {
    return unsupported("codex goal.set does not support the requested status");
  }
  if (options.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
    return unsupported("codex goal tokenBudget must be a positive safe integer");
  }
  if (typeof options.objective !== "string") { return unsupported("codex goal.set requires an objective string"); }
  return null;
}

/** Native replies enter frames at their wire position; control responses only accept or reject. */
export function codexGoalControl(kernel: SessionKernel, client: AppServerClient, threadId: string): AdapterGoalControl {
  const send = async (action: "set" | "read" | "clear", options?: GoalSetOptions): Promise<ControlResult> => {
    const method = `thread/goal/${action === "read" ? "get" : action}`;
    const result = await rpcControl(kernel, client, {
      body: action === "set" ? { kind: "goal_set", options: options ?? { objective: "" } } : { kind: action === "read" ? "goal_read" : "goal_clear" },
      gate: () => options === undefined ? null : setRefusal(options),
      method,
      params: () => ({ threadId, ...(action === "read" ? {} : { origin: "user" }), ...options }),
      onReply: (reply) => {
        // A successful clear, including cleared:false, confirms there is no goal.
        const goal = action === "clear" ? (typeof reply.cleared === "boolean" ? null : undefined) : codexGoal(reply.goal);
        const valid = goal !== undefined && (action !== "set" || goal !== null);
        client.mark(() => { kernel.frame({ type: method, native: reply, events: valid ? [{ kind: "goal_changed", goal }] : [] }); });
        return valid ? { kind: "accepted" } : {
          kind: "rejected", code: "runtime_refused", reason: "codex goal response did not report a valid outcome",
        };
      },
      onError: (reason, native) => ({ kind: "rejected", code: "runtime_refused", reason, ...(native === undefined ? {} : { native }) }),
    });
    return result;
  };
  return { set: send.bind(null, "set"), read: send.bind(null, "read"), clear: send.bind(null, "clear") };
}
