import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { extensionPlanOf } from "../../shared/extension-plan.js";
import { asRecord } from "../../shared/json.js";
import { piExtensionIdentity, type PiLoadedTool } from "./tools.js";

/**
 * The checklist an EXTENSION tool's successful result reports. Pi registers no
 * checklist tool and tracks no plan of its own, so a checklist can only come
 * from an extension the session loaded; OAR reads the RESULT (never the
 * requested arguments), and only when that session's own tool report confirms
 * the tool and names its source. The event says `channel: "extension"` and
 * carries that identity plus the protocol version the result declared. A
 * failed call, an unreadable result, a protocol OAR does not read, or a tool
 * the session did not report as an extension reports nothing at all.
 */
export function piExtensionPlanEvents(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>, loadedTools: readonly PiLoadedTool[] | undefined): RuntimeEventBody[] {
  if (event.isError) {
    return [];
  }
  const reported = extensionPlanOf(asRecord(event.result)?.details);
  if (reported === null) {
    return [];
  }
  const identity = piExtensionIdentity(loadedTools, event.toolName);
  if (identity === null) {
    return [];
  }
  return [{
    kind: "plan_changed",
    plan: reported.plan,
    evidence: "tool_call",
    callId: event.toolCallId,
    channel: "extension",
    extension: { ...identity, protocol: reported.protocol },
  }];
}
