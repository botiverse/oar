/**
 * Subagents: child sessions on any runtime that a host starts, follows and
 * feeds back into a parent. Node-only, like the root entry. See
 * docs/spec/subagents.md.
 */
export { createSubagents, formatReport, SUBAGENT_DEPTH_ENV } from "./crew.js";
export type {
  DeliverOptions,
  SendMode,
  SendResult,
  SpawnOptions,
  SpawnRefusalCode,
  SpawnResult,
  Subagent,
  SubagentInfo,
  SubagentReport,
  Subagents,
  SubagentsOptions,
  SubagentState,
  SubagentTaskEvent,
  WaitOptions,
} from "./types.js";
