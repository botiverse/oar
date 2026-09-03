import { describe, expect, test } from "vitest";
import type {
  AgentViewUpdate,
  ConversationEntry,
  SessionEventView,
  SessionIdentity,
} from "../src/shared/ipc.js";
import {
  broadcastRegattaPrompt,
  initialRegattaState,
  reduceRegattaEvents,
  type RegattaState,
} from "../src/renderer/views/regatta/regatta-model.js";

const identities: readonly SessionIdentity[] = [
  {
    laneId: "alpha",
    runtimeId: "claude",
    sessionId: "session-alpha",
    cwd: "/tmp/oar",
    model: "sonnet",
  },
  {
    laneId: "beta",
    runtimeId: "codex",
    sessionId: "session-beta",
    cwd: "/tmp/oar",
    model: "o4-mini",
  },
];

const alphaView: AgentViewUpdate = {
  status: {
    kind: "running",
    turnId: "alpha-turn",
    phase: "thinking",
    lastEventAt: 101,
  },
  stall: null,
  simple: "busy",
};

const alphaEvent: SessionEventView = {
  sessionId: "session-alpha",
  turnId: "alpha-turn",
  seq: 0,
  receivedAt: 100,
  kind: "turn_started",
};

const alphaConversation: ConversationEntry = {
  kind: "human",
  id: "human-alpha",
  text: "hello both lanes",
  receivedAt: 102,
  delivery: "prompted",
};

function lane(state: RegattaState, laneId: string) {
  const result = state.find((entry) => entry.identity.laneId === laneId);
  if (result === undefined) {
    throw new Error(`missing lane ${laneId}`);
  }
  return result;
}

describe("Regatta state", () => {
  test("keeps activity, conversation, views, and errors isolated by lane", () => {
    const initial = initialRegattaState(identities);
    const next = reduceRegattaEvents(initial, [
      { kind: "agent_view", laneId: "alpha", view: alphaView },
      { kind: "activity", laneId: "alpha", event: alphaEvent },
      { kind: "conversation", laneId: "alpha", entry: alphaConversation },
      { kind: "host_error", laneId: "alpha", message: "alpha warning" },
      // An untagged/global event and an unknown lane must not leak into a
      // column. They are handled by the host-level surface instead.
      { kind: "host_error", message: "global warning" },
      {
        kind: "conversation",
        laneId: "missing",
        entry: alphaConversation,
      },
    ]);

    const alpha = lane(next, "alpha");
    const beta = lane(next, "beta");
    expect({
      view: alpha.agentView,
      activity: alpha.activity,
      conversation: alpha.conversation,
      hostError: alpha.hostError,
    }).toMatchInlineSnapshot(`
      {
        "activity": [
          {
            "kind": "turn_started",
            "receivedAt": 100,
            "seq": 0,
            "sessionId": "session-alpha",
            "turnId": "alpha-turn",
          },
        ],
        "conversation": [
          {
            "delivery": "prompted",
            "id": "human-alpha",
            "kind": "human",
            "receivedAt": 102,
            "text": "hello both lanes",
          },
        ],
        "hostError": "alpha warning",
        "view": {
          "simple": "busy",
          "stall": null,
          "status": {
            "kind": "running",
            "lastEventAt": 101,
            "phase": "thinking",
            "turnId": "alpha-turn",
          },
        },
      }
    `);
    expect(beta).toBe(initial[1]);
    expect(beta.activity).toEqual([]);
    expect(beta.conversation).toEqual([]);
    expect(beta.hostError).toBeNull();
  });
});

describe("broadcastRegattaPrompt", () => {
  test("starts every lane submission before either result resolves", async () => {
    const state = initialRegattaState(identities);
    const calls: (readonly [string, string])[] = [];
    const alphaReady = Promise.withResolvers<void>();
    const betaReady = Promise.withResolvers<void>();

    const result = broadcastRegattaPrompt(state, "compare", async (laneId, text) => {
      calls.push([laneId, text]);
      await (laneId === "alpha" ? alphaReady.promise : betaReady.promise);
      return { landed: "prompted", turnId: `${laneId}-turn` };
    });

    expect(calls).toEqual([
      ["alpha", "compare"],
      ["beta", "compare"],
    ]);
    betaReady.resolve();
    alphaReady.resolve();
    await expect(result).resolves.toEqual({
      accepted: 2,
      total: 2,
      rejected: [],
    });
  });

  test("retains partial rejections and turns thrown submits into lane errors", async () => {
    const state = initialRegattaState(identities);
    await expect(broadcastRegattaPrompt(state, "compare", async (laneId) => {
      if (laneId === "alpha") {
        return { landed: "rejected", reason: "turn is already running" };
      }
      throw new Error("renderer disconnected");
    })).resolves.toMatchInlineSnapshot(`
      {
        "accepted": 0,
        "rejected": [
          "claude: turn is already running",
          "codex: renderer disconnected",
        ],
        "total": 2,
      }
    `);
  });

  test("counts accepted lanes while preserving a rejected lane", async () => {
    const state = initialRegattaState(identities);
    await expect(broadcastRegattaPrompt(state, "compare", async (laneId) =>
      laneId === "alpha"
        ? { landed: "prompted", turnId: "alpha-turn" }
        : { landed: "rejected", reason: "not available" },
    )).resolves.toEqual({
      accepted: 1,
      total: 2,
      rejected: ["codex: not available"],
    });
  });

  test("returns an empty receipt when there are no lanes", async () => {
    await expect(broadcastRegattaPrompt([], "compare", async () => ({
      landed: "prompted",
      turnId: "unused",
    }))).resolves.toEqual({ accepted: 0, total: 0, rejected: [] });
  });
});
