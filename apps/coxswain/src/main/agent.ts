import {
  observeAgent,
  runtimes,
  simpleStateOf,
  type AgentObserver,
  type AvailableInstallation,
  type InstallationSnapshot,
  type Runtime,
  type Session,
  type Turn,
} from "@botiverse/oar";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AbortReceipt,
  HostEvent,
  InspectResult,
  InstallationView,
  LaunchRequest,
  RuntimeInspection,
  SessionIdentity,
  SubmitReceipt,
  UsageResult,
  UsageSnapshotView,
} from "../shared/ipc.js";
import { createSayBridge, type SayBridge } from "./say-bridge.js";

const STALL_AFTER_MS = 15_000;
const SAY_TOOL_GRANTS = ["Bash(say:*)"] as const;

const SAY_PROTOCOL = `You are running inside the coxswain OAR dogfood cockpit.
The human-facing conversation shows only messages delivered through the injected \`say\` CLI. Raw assistant text is visible only as diagnostic activity.
Whenever you want the human to see a reply or progress update, run \`say "your message"\` (or pipe text to \`say\`). Do not treat raw assistant text as a delivered reply.

Human message:
`;

const SMOKE_RUNTIMES: readonly RuntimeInspection[] = [
  {
    id: "claude",
    installation: {
      kind: "available",
      via: "executable",
      command: "claude",
      version: "2.1.237",
    },
    supportsUsage: true,
  },
  {
    id: "codex",
    installation: {
      kind: "available",
      via: "executable",
      command: "codex",
      version: "0.48.0",
    },
    supportsUsage: true,
  },
  {
    id: "pi",
    installation: { kind: "available", via: "bundled" },
    supportsUsage: false,
  },
];

const SMOKE_USAGE: UsageSnapshotView = {
  kind: "available",
  plan: "Max",
  rateLimited: false,
  windows: [
    { label: "current session", usedRatio: 0.07, resetsAt: "2026-08-23T19:39:00.000Z" },
    { label: "week · all models", usedRatio: 0.32 },
  ],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown host error";
}

function installationView(snapshot: InstallationSnapshot): InstallationView {
  switch (snapshot.kind) {
    case "available":
      if (snapshot.via === "bundled") {
        return { kind: "available", via: "bundled" };
      }
      return snapshot.version === undefined
        ? {
            kind: "available",
            via: "executable",
            command: snapshot.command,
          }
        : {
            kind: "available",
            via: "executable",
            command: snapshot.command,
            version: snapshot.version,
          };
    case "not_found":
      return { kind: "not_found" };
    case "unsupported":
      return { kind: "unsupported", reason: snapshot.reason };
  }
  throw new Error("Unknown installation state");
}

function usageView(usage: UsageSnapshotView): UsageSnapshotView {
  if (usage.kind !== "available") {
    return usage;
  }
  return usage.plan === undefined
    ? {
        kind: "available",
        rateLimited: usage.rateLimited,
        windows: usage.windows.map((window) => window.resetsAt === undefined
          ? { label: window.label, usedRatio: window.usedRatio }
          : {
              label: window.label,
              usedRatio: window.usedRatio,
              resetsAt: window.resetsAt,
            }),
      }
    : {
        kind: "available",
        plan: usage.plan,
        rateLimited: usage.rateLimited,
        windows: usage.windows.map((window) => window.resetsAt === undefined
          ? { label: window.label, usedRatio: window.usedRatio }
          : {
              label: window.label,
              usedRatio: window.usedRatio,
              resetsAt: window.resetsAt,
            }),
      };
}

async function resolveWorkingDirectory(input: string): Promise<string> {
  const expanded = input === "~"
    ? homedir()
    : input.startsWith("~/")
      ? join(homedir(), input.slice(2))
      : input;
  const absolute = resolve(expanded);
  const metadata = await stat(absolute);
  if (!metadata.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${absolute}`);
  }
  return absolute;
}

export interface AgentHostOptions {
  readonly smoke?: boolean;
}

export class AgentHost {
  readonly #smoke: boolean;
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #installations = new Map<string, AvailableInstallation>();
  #session: Session | null = null;
  #turn: Turn | null = null;
  #sayBridge: SayBridge | null = null;
  #agentObserver: AgentObserver | null = null;
  #unsubscribeEvents: (() => void) | null = null;
  #unsubscribeAgent: (() => void) | null = null;
  #protocolSent = false;
  #disposed = false;

  constructor(options: AgentHostOptions = {}) {
    this.#smoke = options.smoke ?? false;
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: HostEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  async #probeRuntime(runtime: Runtime): Promise<RuntimeInspection> {
    if (runtime.installation === undefined) {
      return {
        id: runtime.id,
        installation: { kind: "unsupported", reason: "installation probe unavailable" },
        supportsUsage: runtime.accountUsage !== undefined,
      };
    }
    try {
      const installation = await runtime.installation();
      if (installation.kind === "available") {
        this.#installations.set(runtime.id, installation);
      }
      return {
        id: runtime.id,
        installation: installationView(installation),
        supportsUsage: runtime.accountUsage !== undefined,
      };
    } catch (error) {
      return {
        id: runtime.id,
        installation: { kind: "error", reason: messageOf(error) },
        supportsUsage: runtime.accountUsage !== undefined,
      };
    }
  }

  async inspect(): Promise<InspectResult> {
    if (this.#smoke) {
      return { defaultCwd: "~/play/oar-demo", runtimes: SMOKE_RUNTIMES };
    }
    const inspected = await Promise.all(runtimes.list().map(async (runtime) =>
      this.#probeRuntime(runtime)));
    return { defaultCwd: process.cwd(), runtimes: inspected };
  }

  async #availableInstallation(runtime: Runtime): Promise<AvailableInstallation | null> {
    const cached = this.#installations.get(runtime.id);
    if (cached !== undefined) {
      return cached;
    }
    if (runtime.installation === undefined) {
      return null;
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      return null;
    }
    this.#installations.set(runtime.id, installation);
    return installation;
  }

  async readUsage(runtimeId: string): Promise<UsageResult> {
    if (this.#smoke) {
      return runtimeId === "claude"
        ? { kind: "loaded", usage: SMOKE_USAGE }
        : { kind: "loaded", usage: { kind: "unsupported" } };
    }
    const runtime = runtimes.get(runtimeId);
    if (runtime === undefined) {
      return { kind: "error", reason: `unknown runtime: ${runtimeId}` };
    }
    if (runtime.accountUsage === undefined) {
      return { kind: "loaded", usage: { kind: "unsupported" } };
    }
    try {
      const installation = await this.#availableInstallation(runtime);
      if (installation === null) {
        return { kind: "unavailable", reason: `${runtimeId} is not available` };
      }
      const usage = await runtime.accountUsage(installation);
      return { kind: "loaded", usage: usageView(usage) };
    } catch (error) {
      return { kind: "error", reason: messageOf(error) };
    }
  }

  #watchTurn(turn: Turn): void {
    this.#turn = turn;
    void turn.outcome.then(() => {
      if (this.#turn === turn) {
        this.#turn = null;
      }
    }).catch((error: unknown) => {
      this.#emit({ kind: "host_error", message: messageOf(error) });
    });
  }

  #wireInput(input: string): string {
    return this.#protocolSent ? input : `${SAY_PROTOCOL}${input}`;
  }

  #emitHuman(text: string, delivery: "prompted" | "steered" | "queued"): void {
    this.#emit({
      kind: "conversation",
      entry: {
        kind: "human",
        id: randomUUID(),
        text,
        receivedAt: Date.now(),
        delivery,
      },
    });
  }

  async launch(request: LaunchRequest): Promise<SessionIdentity> {
    if (this.#disposed) {
      throw new Error("The coxswain host is disposed");
    }
    await this.#disposeSession();
    const runtime = runtimes.require(request.runtimeId);
    const installation = await this.#availableInstallation(runtime);
    if (installation === null) {
      throw new Error(`${request.runtimeId} is not available`);
    }
    const cwd = await resolveWorkingDirectory(request.cwd);
    const sayBridge = await createSayBridge((text) => {
      this.#emit({
        kind: "conversation",
        entry: {
          kind: "agent",
          id: randomUUID(),
          text,
          receivedAt: Date.now(),
        },
      });
    });

    let session: Session | null = null;
    try {
      session = await runtime.session(installation, {
        allowTools: SAY_TOOL_GRANTS,
        cwd,
        env: sayBridge.env,
        ...(request.model === undefined ? {} : { model: request.model }),
      });
    } catch (error) {
      await sayBridge.dispose();
      throw error;
    }
    this.#session = session;
    this.#sayBridge = sayBridge;
    this.#protocolSent = false;
    this.#unsubscribeEvents = session.subscribe((event) => {
      this.#emit({ kind: "activity", event });
      if (event.kind === "turn_ended") {
        this.#emit({
          kind: "conversation",
          entry: {
            kind: "outcome",
            id: randomUUID(),
            turnId: event.turnId,
            receivedAt: event.receivedAt,
            outcome: event.outcome,
          },
        });
      }
    });
    const agentObserver = observeAgent(session, { stallAfterMs: STALL_AFTER_MS });
    this.#agentObserver = agentObserver;
    this.#unsubscribeAgent = agentObserver.subscribe((view) => {
      this.#emit({
        kind: "agent_view",
        view: { status: view.status, stall: view.stall, simple: simpleStateOf(view) },
      });
    });

    return request.model === undefined
      ? { runtimeId: runtime.id, sessionId: session.id, cwd }
      : { runtimeId: runtime.id, sessionId: session.id, cwd, model: request.model };
  }

  async submit(text: string): Promise<SubmitReceipt> {
    const session = this.#session;
    if (session === null) {
      return { landed: "rejected", reason: "No agent session is running" };
    }
    const activeTurn = this.#turn;
    if (activeTurn !== null) {
      const result = await session.steerOrQueue(activeTurn, this.#wireInput(text));
      if (result.landed === "rejected") {
        return result;
      }
      this.#protocolSent = true;
      this.#emitHuman(text, result.landed);
      return { landed: result.landed, turnId: activeTurn.id };
    }

    const result = session.prompt(this.#wireInput(text));
    if (result.kind === "busy") {
      return {
        landed: "rejected",
        reason: "The runtime is busy without a controllable turn handle",
      };
    }
    this.#protocolSent = true;
    this.#watchTurn(result.turn);
    this.#emitHuman(text, "prompted");
    return { landed: "prompted", turnId: result.turn.id };
  }

  async abort(): Promise<AbortReceipt> {
    const turn = this.#turn;
    if (turn === null) {
      return { aborted: false };
    }
    await turn.abort();
    return { aborted: true };
  }

  async #disposeSession(): Promise<void> {
    this.#unsubscribeAgent?.();
    this.#unsubscribeAgent = null;
    this.#agentObserver?.dispose();
    this.#agentObserver = null;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;

    const session = this.#session;
    const bridge = this.#sayBridge;
    this.#session = null;
    this.#turn = null;
    this.#sayBridge = null;
    this.#protocolSent = false;
    try {
      if (session !== null) {
        await session.dispose();
      }
    } finally {
      if (bridge !== null) {
        await bridge.dispose();
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#disposeSession();
    this.#listeners.clear();
  }
}
