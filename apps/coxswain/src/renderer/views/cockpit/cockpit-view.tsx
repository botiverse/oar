import type {
  AgentViewUpdate,
  ConversationEntry,
  SessionEventView,
  SessionIdentity,
} from "../../../shared/ipc.js";
import { Activity } from "./activity/activity.js";
import { Conversation } from "./conversation/conversation.js";
import { StatusBar } from "./status-bar/status-bar.js";

export interface CockpitViewProps {
  readonly activity: readonly SessionEventView[];
  readonly agentView: AgentViewUpdate;
  readonly conversation: readonly ConversationEntry[];
  readonly hostError: string | null;
  readonly session: SessionIdentity;
}

export function CockpitView(props: CockpitViewProps): React.JSX.Element {
  return (
    <main className="flex h-full min-h-0 flex-col bg-ink-950 text-zinc-300" data-view="cockpit">
      <StatusBar agentView={props.agentView} session={props.session} />
      {props.hostError === null ? null : (
        <div className="shrink-0 border-b border-rose-500/10 bg-rose-500/5 px-4 py-1.5 text-xs text-rose-400/80">
          host · {props.hostError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Conversation agentView={props.agentView} entries={props.conversation} />
        <Activity
          agentView={props.agentView}
          events={props.activity}
          runtimeId={props.session.runtimeId}
        />
      </div>
    </main>
  );
}
