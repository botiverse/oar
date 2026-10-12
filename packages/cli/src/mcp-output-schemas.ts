/** MCP output schemas describe the objects a programmatic caller receives. */
const identity = {
  id: { type: "string" },
  name: { type: "string" },
  runtime: { type: "string" },
  sessionId: { type: "string" },
  log: { type: "string" },
};

const info = {
  type: "object",
  properties: {
    ...identity,
    state: { type: "string", enum: ["running", "idle", "closed"] },
    turns: { type: "integer" },
  },
  required: ["id", "runtime", "sessionId", "state", "turns"],
};

const report = {
  type: "object",
  properties: {
    ...identity,
    turn: { type: "integer" },
    outcome: {
      type: "object",
      anyOf: [
        { properties: { kind: { const: "completed" }, structuredOutput: {} }, required: ["kind"] },
        { properties: { kind: { const: "aborted" } }, required: ["kind"] },
        {
          properties: {
            kind: { const: "failed" },
            failure: { type: "string", description: "OAR's failure classification." },
            reason: { type: "string" },
            status: { type: "number" },
            credential: { type: "string", enum: ["missing", "rejected"] },
            resetsAt: { type: "string" },
          },
          required: ["kind", "failure", "reason"],
        },
      ],
    },
    text: { type: "string" },
    endedAt: { type: "number", description: "Unix time in milliseconds." },
  },
  required: ["id", "runtime", "sessionId", "turn", "outcome", "text", "endedAt"],
};

export const RUN_OUTPUT_SCHEMA = {
  type: "object",
  description: "A turn report, a spawn refusal, or the subagent's info if it closed before reporting.",
  anyOf: [
    report,
    {
      type: "object",
      properties: { kind: { const: "refused" }, code: { type: "string" }, reason: { type: "string" } },
      required: ["kind", "code", "reason"],
    },
    info,
  ],
};

export const WAIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: { reports: { type: "array", items: report } },
  required: ["reports"],
};

export const LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    agents: { type: "array", items: info },
    unread: {
      type: "array",
      description: "Finished turns whose reports are still unread; call wait to take them.",
      items: {
        type: "object",
        properties: { id: { type: "string" }, turn: { type: "integer" } },
        required: ["id", "turn"],
      },
    },
  },
  required: ["agents", "unread"],
};
