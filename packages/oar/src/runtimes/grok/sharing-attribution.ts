import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { AcpAssociation } from "../../shared/acp/routing.js";

/** A native spawn frame proves ancestry before child output; completion must never grant it. */
export function grokSharedAssociations(method: string, params: JsonRecord): readonly AcpAssociation[] {
  const update = asRecord(params.update);
  if (method !== "_x.ai/session_notification" || update?.sessionUpdate !== "subagent_spawned") { return []; }
  const parent = update.parent_session_id; const child = update.child_session_id;
  return typeof parent === "string" && parent.length > 0 && typeof child === "string" && child.length > 0 ? [{ parent, child }] : [];
}

/** Check the completed result's explicit parent/child pair against accepted spawn evidence. */
export function grokSharedAssociationChecks(method: string, params: JsonRecord): readonly AcpAssociation[] {
  const update = asRecord(params.update); const output = asRecord(update?.rawOutput);
  if (method !== "session/update" || update?.sessionUpdate !== "tool_call_update" || update.status !== "completed" || output?.type !== "SubagentCompleted") { return []; }
  const parent = params.sessionId; const child = output.subagent_id;
  return typeof parent === "string" && parent.length > 0 && typeof child === "string" && child.length > 0 ? [{ parent, child }] : [];
}
