import type { JsonRecord } from "../../shared/json.js";

/** The same noninteractive allow policy used on both native transports. */
export function qoderPermissionResponse(requestId: string, request: JsonRecord): JsonRecord {
  return { type: "control_response", response: { subtype: "success", request_id: requestId,
    response: { behavior: "allow", ...(request.input === undefined ? {} : { updatedInput: request.input }) } } };
}
