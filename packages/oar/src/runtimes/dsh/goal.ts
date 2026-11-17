/* oxlint-disable eslint/require-await -- Goal controls return the kernel and native request promises directly. */
import type { AdapterGoalControl, GoalSetOptions, GoalSnapshot } from "../../contracts/goal.js";
import type { ResponseBody, RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { DshControl } from "./control.js";

/** Native milliseconds become contract seconds; round counters are not token counters. */
export function dshGoal(value: unknown, times = asRecord(value)): GoalSnapshot | null | undefined {
  if (value === null) { return null; }
  const goal = asRecord(value);
  if (typeof goal?.objective !== "string" || typeof goal.phase !== "string") { return undefined; }
  const fields = Object.fromEntries(["createdAt", "updatedAt"].flatMap((key) => {
    const time = times?.[key];
    return typeof time === "number" && Number.isFinite(time) ? [[key, time / 1000]] : [];
  }));
  return { objective: goal.objective, status: goal.phase, ...fields };
}

export function dshGoalEvents(data: JsonRecord): RuntimeEventBody[] {
  if (data.version !== 1) { return []; }
  if (data.operation === "clear" && typeof asRecord(data.cleared)?.id === "string") { return [{ kind: "goal_changed", goal: null }]; }
  const goal = dshGoal(data.goal, data);
  return goal === undefined ? [] : [{ kind: "goal_changed", goal }];
}

function setRefusal(options: GoalSetOptions): ResponseBody | null {
  let reason: string | undefined = undefined;
  if (Object.keys(options).some((key) => !["objective", "status", "tokenBudget"].includes(key))) { reason = "DSH goal.set supports only objective and status"; }
  else if (options.tokenBudget !== undefined) { reason = "DSH budgets count rounds, not tokens"; }
  else if (options.status !== undefined && !["active", "paused", "complete"].includes(options.status)) { reason = "DSH goal.set supports active, paused and complete; blocked needs a native reason not represented by GoalSetOptions"; }
  else if (typeof options.objective !== "string") { reason = "DSH goal.set requires an objective string"; }
  return reason === undefined ? null : { kind: "rejected", code: "unsupported", reason };
}

/** The bridge emits native observations before its command response; no optimistic state. */
export function dshGoalControl(kernel: SessionKernel, control: DshControl, sessionId: string, refusalOf: (error: unknown) => ResponseBody): AdapterGoalControl {
  const send = async (method: string, options?: GoalSetOptions): Promise<ResponseBody> => {
    const refusal = options === undefined ? null : setRefusal(options);
    if (refusal !== null) { return refusal; }
    try {
      const reply = await control.request(method, { sessionId, ...(options === undefined ? {} : { options: { ...options } }) });
      const observed = dshGoal(reply.goal);
      return observed === undefined || (method === "goalSet" && observed === null)
        ? { kind: "rejected", code: "runtime_refused", reason: "DSH did not report a valid goal observation", native: reply }
        : { kind: "accepted", native: reply };
    } catch (error) { return refusalOf(error); }
  };
  return {
    set: async (options) => kernel.control({ kind: "goal_set", options }, async () => send("goalSet", options)),
    read: async () => kernel.control({ kind: "goal_read" }, async () => send("goalRead")),
    clear: async () => kernel.control({ kind: "goal_clear" }, async () => send("goalClear")),
  };
}
