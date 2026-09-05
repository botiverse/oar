import { useEffect, useMemo, useState } from "react";
import type {
  AgentViewUpdate,
  ConversationEntry,
  FleetSnapshot,
  SessionEventView,
  SessionIdentity,
  LaunchFleetRequest,
  AbortReceipt,
} from "../shared/ipc.js";
import { CockpitView } from "./views/cockpit/cockpit-view.js";
import { LaunchView } from "./views/launch/launch-view.js";
import { RegattaView } from "./views/regatta/regatta-view.js";
import {
  broadcastRegattaPrompt,
  initialRegattaState,
  reduceRegattaEvent,
  type BroadcastReceipt,
  type RegattaState,
} from "./views/regatta/regatta-model.js";
import { smokeRegattaFixture } from "./views/regatta/regatta-fixture.js";

const INITIAL_AGENT_VIEW: AgentViewUpdate = {
  status: { kind: "idle" },
  stall: null,
  simple: "idle",
};

async function abortRegattaLane(laneId: string): Promise<AbortReceipt> {
  return window.coxswain.abort({ laneId });
}

export function App(): React.JSX.Element {
  const smoke = window.location.hash === "#smoke";
  const [session, setSession] = useState<SessionIdentity | null>(null);
  const [agentView, setAgentView] = useState<AgentViewUpdate>(INITIAL_AGENT_VIEW);
  const [conversation, setConversation] = useState<readonly ConversationEntry[]>([]);
  const [activity, setActivity] = useState<readonly SessionEventView[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [regatta, setRegatta] = useState<RegattaState | null>(null);
  const smokeFixture = useMemo(() => smokeRegattaFixture(), []);

  useEffect(() => {
    if (smoke) {
      void window.coxswain.rendererReady();
      return (): void => {};
    }
    return window.coxswain.onHostEvent((event) => {
      if (event.laneId !== undefined) {
        setRegatta((current) => current === null ? current : reduceRegattaEvent(current, event));
      }
      switch (event.kind) {
        case "activity":
          setActivity((current) => [...current, event.event]);
          break;
        case "agent_view":
          setAgentView(event.view);
          break;
        case "conversation":
          setConversation((current) => [...current, event.entry]);
          break;
        case "host_error":
          setHostError(event.message);
          break;
      }
    });
  }, [smoke]);

  const launchRegatta = async (request: LaunchFleetRequest): Promise<void> => {
    const identities = await window.coxswain.launchFleet(request);
    setRegatta(initialRegattaState(identities));
    setSession(null);
    const snapshot: FleetSnapshot = await window.coxswain.fleet();
    const views = new Map(snapshot.lanes.map((lane) => [lane.identity.laneId, lane.view]));
    setRegatta((current) => current === null
      ? initialRegattaState(identities, views)
      : current.map((lane) => ({
          ...lane,
          agentView: views.get(lane.identity.laneId) ?? lane.agentView,
        })));
  };

  const broadcast = async (text: string): Promise<BroadcastReceipt> => {
    const lanes = regatta ?? [];
    return broadcastRegattaPrompt(lanes, text, async (laneId, prompt) =>
      window.coxswain.submit({ laneId, text: prompt }));
  };

  if (smoke) {
    return (
      <RegattaView
        lanes={smokeFixture.state}
        onAbort={async (): Promise<AbortReceipt> => ({ aborted: false })}
        onBroadcast={async (): Promise<BroadcastReceipt> => ({
          accepted: 0,
          total: smokeFixture.state.length,
          rejected: ["smoke fixture is read-only"],
        })}
      />
    );
  }

  if (regatta !== null) {
    return <RegattaView lanes={regatta} onAbort={abortRegattaLane} onBroadcast={broadcast} />;
  }
  if (session === null) {
    return <LaunchView onLaunch={setSession} onRegattaLaunch={launchRegatta} />;
  }

  return (
    <CockpitView
      activity={activity}
      agentView={agentView}
      conversation={conversation}
      hostError={hostError}
      session={session}
    />
  );
}
