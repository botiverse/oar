import { useEffect, useState } from "react";
import type {
  AgentViewUpdate,
  ConversationEntry,
  SessionEventView,
  SessionIdentity,
} from "../shared/ipc.js";
import { CockpitView } from "./views/cockpit/cockpit-view.js";
import { LaunchView } from "./views/launch/launch-view.js";

const INITIAL_AGENT_VIEW: AgentViewUpdate = {
  status: { kind: "idle" },
  stall: null,
  simple: "idle",
};

export function App(): React.JSX.Element {
  const [session, setSession] = useState<SessionIdentity | null>(null);
  const [agentView, setAgentView] = useState<AgentViewUpdate>(INITIAL_AGENT_VIEW);
  const [conversation, setConversation] = useState<readonly ConversationEntry[]>([]);
  const [activity, setActivity] = useState<readonly SessionEventView[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);

  useEffect(() => window.coxswain.onHostEvent((event) => {
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
  }), []);

  if (session === null) {
    return <LaunchView onLaunch={setSession} />;
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
