import { useEffect, useRef, useState, type SubmitEvent } from "react";
import type {
  InspectResult,
  RuntimeInspection,
  SessionIdentity,
  UsageResult,
  UsageSnapshotView,
} from "../../../shared/ipc.js";
import { formatReset } from "./usage-model.js";

interface LaunchViewProps {
  readonly onLaunch: (session: SessionIdentity) => void;
}

type UsageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: UsageResult };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to launch the agent";
}

function installationDetail(runtime: RuntimeInspection): string {
  const installation = runtime.installation;
  if (installation.kind !== "available") {
    return installation.kind.replaceAll("_", " ");
  }
  if (installation.via === "bundled") {
    return "bundled sdk";
  }
  return `${installation.version ?? "version unknown"} · executable`;
}

function availabilityLabel(runtime: RuntimeInspection): string {
  const installation = runtime.installation;
  switch (installation.kind) {
    case "available":
      return "available";
    case "not_found":
      return "not found";
    case "unsupported":
      return "unsupported";
    case "error":
      return "probe error";
  }
  throw new Error("Unknown installation state");
}

function RuntimeCard(props: {
  readonly runtime: RuntimeInspection;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const available = props.runtime.installation.kind === "available";
  const detail = installationDetail(props.runtime);
  return (
    <button
      aria-checked={props.selected}
      className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
        props.selected
          ? "border-oar-600/60 bg-oar-500/5"
          : "border-white/5 hover:border-white/10"
      } ${available ? "" : "opacity-60"}`}
      data-runtime-id={props.runtime.id}
      disabled={!available}
      onClick={props.onSelect}
      role="radio"
      title={props.runtime.installation.kind === "error"
        ? props.runtime.installation.reason
        : detail}
      type="button"
    >
      <span className={`size-2 shrink-0 rounded-full ${
        props.selected ? "bg-oar-500" : "bg-ink-600"
      }`} />
      <span className={`font-medium ${props.selected ? "text-zinc-100" : "text-zinc-300"}`}>
        {props.runtime.id}
      </span>
      <span className="truncate font-mono text-xs text-zinc-500">{detail}</span>
      <span className={`ml-auto shrink-0 text-xs ${props.selected ? "text-oar-500" : "text-zinc-500"}`}>
        {availabilityLabel(props.runtime)}
      </span>
    </button>
  );
}

function UsageWindows({ usage }: { readonly usage: UsageSnapshotView }): React.JSX.Element {
  if (usage.kind === "reauth_required") {
    return <p className="text-xs text-amber-500/80">sign in again to inspect account usage</p>;
  }
  if (usage.kind === "unsupported") {
    return <p className="text-xs text-zinc-600">account usage is not exposed by this runtime</p>;
  }
  if (usage.windows.length === 0) {
    return <p className="text-xs text-zinc-600">no usage windows reported</p>;
  }
  return (
    <div className="space-y-3">
      {usage.windows.map((window) => {
        const percent = Math.round(Math.min(1, Math.max(0, window.usedRatio)) * 100);
        return (
          <div className="space-y-1.5" key={window.label}>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">{window.label}</span>
              <span className="font-mono text-zinc-400">
                {percent}%{formatReset(window.resetsAt)}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-ink-700">
              <div className="h-full rounded bg-oar-600" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsagePanel({ state }: { readonly state: UsageState }): React.JSX.Element {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="rounded-lg bg-ink-850 px-4 py-4 text-xs text-zinc-600">
        {state.kind === "loading" ? "reading selected account usage…" : "select a runtime"}
      </div>
    );
  }
  if (state.result.kind === "error" || state.result.kind === "unavailable") {
    return (
      <div className="rounded-lg bg-ink-850 px-4 py-4 text-xs text-zinc-600">
        usage unavailable · {state.result.reason}
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-ink-850 px-4 py-3">
      <UsageWindows usage={state.result.usage} />
    </div>
  );
}

export function LaunchView({ onLaunch }: LaunchViewProps): React.JSX.Element {
  const [inspection, setInspection] = useState<InspectResult | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [usage, setUsage] = useState<UsageState>({ kind: "idle" });
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const readySent = useRef(false);

  useEffect(() => {
    let current = true;
    void window.coxswain.inspect().then((result) => {
      if (!current) {
        return;
      }
      setInspection(result);
      setCwd(result.defaultCwd);
      const firstAvailable = result.runtimes.find((runtime) =>
        runtime.installation.kind === "available");
      setSelectedId(firstAvailable?.id ?? result.runtimes[0]?.id ?? "");
      setLoading(false);
    }).catch((error: unknown) => {
      if (current) {
        setLaunchError(messageOf(error));
        setLoading(false);
      }
    });
    return (): void => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    if (selectedId.length === 0) {
      setUsage({ kind: "idle" });
    } else {
      setUsage({ kind: "loading" });
      void window.coxswain.readUsage(selectedId).then((result) => {
        if (current) {
          setUsage({ kind: "ready", result });
        }
      }).catch((error: unknown) => {
        if (current) {
          setUsage({ kind: "ready", result: { kind: "error", reason: messageOf(error) } });
        }
      });
    }
    return (): void => {
      current = false;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!loading && inspection !== null && usage.kind !== "loading" && !readySent.current) {
      readySent.current = true;
      void window.coxswain.rendererReady();
    }
  }, [inspection, loading, usage]);

  const selected = inspection?.runtimes.find((runtime) => runtime.id === selectedId);
  const canLaunch = selected?.installation.kind === "available" && cwd.trim().length > 0;

  const launch = async (): Promise<void> => {
    if (!canLaunch) {
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    try {
      const trimmedModel = model.trim();
      const request = trimmedModel.length === 0
        ? { runtimeId: selectedId, cwd }
        : { runtimeId: selectedId, cwd, model: trimmedModel };
      onLaunch(await window.coxswain.launch(request));
    } catch (error) {
      setLaunchError(messageOf(error));
      setLaunching(false);
    }
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void launch();
  };

  return (
    <main className="flex h-full min-h-0 flex-col bg-ink-950 text-zinc-300">
      <header className="flex h-10 shrink-0 items-center border-b border-white/5 bg-ink-900 px-4">
        <span className="text-sm font-semibold tracking-tight text-zinc-200">coxswain</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
        <form
          className="w-[520px] space-y-6 rounded-xl border border-white/5 bg-ink-900 p-8 shadow-2xl shadow-black/30"
          onSubmit={submit}
        >
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Launch an agent</h1>
            <p className="mt-1 text-sm text-zinc-500">One run per window. Close the window, the run is gone.</p>
          </div>

          <fieldset className="space-y-2" disabled={loading || launching}>
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Runtime</legend>
            {loading ? (
              <div className="rounded-lg border border-white/5 px-4 py-6 text-center text-xs text-zinc-600">
                probing local runtimes…
              </div>
            ) : inspection?.runtimes.map((runtime) => (
              <RuntimeCard
                key={runtime.id}
                onSelect={() => {
                  setSelectedId(runtime.id);
                }}
                runtime={runtime}
                selected={runtime.id === selectedId}
              />
            ))}
          </fieldset>

          <UsagePanel state={usage} />

          <div className="grid grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Model</span>
              <input
                className="w-full rounded-lg border border-white/5 bg-ink-850 px-3 py-2 font-mono text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-oar-700"
                disabled={launching}
                name="model"
                onChange={(event) => {
                  setModel(event.target.value);
                }}
                placeholder="runtime default"
                value={model}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Working dir</span>
              <input
                className="w-full rounded-lg border border-white/5 bg-ink-850 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-oar-700"
                disabled={launching}
                name="cwd"
                onChange={(event) => {
                  setCwd(event.target.value);
                }}
                value={cwd}
              />
            </label>
          </div>

          {launchError === null ? null : (
            <p className="rounded-lg border border-rose-500/10 bg-rose-500/5 px-3 py-2 text-xs text-rose-400/80">
              {launchError}
            </p>
          )}

          <button
            className="w-full rounded-lg bg-oar-600 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-oar-500 disabled:opacity-40"
            data-action="launch"
            disabled={!canLaunch || launching}
            type="submit"
          >
            {launching ? "Launching…" : "Launch"}
          </button>
        </form>
      </div>
    </main>
  );
}
