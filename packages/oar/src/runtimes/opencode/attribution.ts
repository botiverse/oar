import { asRecord } from "../../shared/json.js";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";

/** v2 forwards child updates on the root envelope; native metadata owns the identity. */
export const opencodeChildAttribution: NonNullable<AcpSessionProfile["attributeUpdate"]> = (notification) => {
  const envelope = asRecord(notification);
  const update = asRecord(envelope?.update);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension field.
  const child = asRecord(asRecord(update?._meta)?.["opencode/child-session"]) ?? asRecord(asRecord(envelope?._meta)?.["opencode/child-session"]);
  if (update === null || typeof child?.id !== "string" || child.id === "" || typeof child.parentID !== "string" || child.parentID === "" || child.id === child.parentID) {
    return null;
  }
  return { sessionId: child.id, parent: child.parentID };
};
