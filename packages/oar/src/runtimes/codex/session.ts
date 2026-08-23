import { randomUUID } from "node:crypto";
import type { Session, StartSession, Turn, TurnOutcome } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { startAppServerClient } from "./app-server-client.js";

/*
 * codex app-server v2 mapping:
 * - initialize → initialized, thread/start {cwd, ephemeral, approvalPolicy:never}
 * - turn/start {threadId, input} → {turn{id}}; completion via turn/completed
 *   notification whose turn.status is completed | interrupted | failed
 * - steer: turn/steer with the expectedTurnId precondition (race adjudicated
 *   at the runtime); typed rejection surfaces as not_steerable
 * - steer `accepted` here means: the runtime confirmed injection into the
 *   active turn (the strongest form; still expressed as the weak contract
 *   promise). Live probe: codex-session-adapter.ts.
 * - abort: turn/interrupt {threadId, turnId}
 */

const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);

interface CodexTurnState {
  readonly kernelTurn: KernelTurn;
  readonly codexTurnId: Promise<string>;
}

// The runtime's own status is the truth: an interrupt that landed reports
// "interrupted"; an interrupt that lost the race to completion reports
// "completed" — mapping a local abort flag over it would falsify the latter.
function outcomeFromStatus(status: unknown): TurnOutcome {
  switch (status) {
    case "interrupted":
      return { kind: "aborted" };
    case "completed":
      return { kind: "completed" };
    default: {
      const reason = typeof status === "string" ? status : "unknown";
      // codex's turn status carries no error detail (pinned by the codex
      // vendor 400/429 snapshots: reason is the bare word "failed").
      return { kind: "failed", reason, failure: classifyFailure(reason) };
    }
  }
}

export const codexSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // OAR_CODEX_SANDBOX pins codex's sandbox mode (default workspace-write).
  // Needed because sandboxed exec is platform-dependent: GitHub's ubuntu
  // runners deny it (tool results come back as sandbox errors) while local
  // Linux and macOS seatbelt allow it — pinned by the tool-round journals.
  const sandboxMode = process.env.OAR_CODEX_SANDBOX ?? "workspace-write";
  const client = startAppServerClient(installation.command, options.env);
  await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id.
  const started = options.resume === undefined
    ? await client.request("thread/start", {
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        approvalPolicy: "never",
        sandboxMode,
      })
    : await client.request("thread/resume", {
        threadId: options.resume,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandboxMode,
      });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError("codex thread start/resume returned no thread id");
  }

  const kernel = createSessionKernel(threadId);
  let current: CodexTurnState | null = null;
  let disposed = false;
  // codex broadcasts structured `error` notifications (message, codexErrorInfo,
  // additionalDetails, willRetry) that its terminal turn status does NOT carry
  // — turn/completed says only "failed". Remember the last one so a failed
  // settle can say WHY (pinned need: CI tool-round failures were undebuggable
  // with the bare word "failed").
  let lastErrorDetail: string | null = null;

  client.onNotification((method, params) => {
    if (params.threadId !== threadId) {
      return;
    }
    if (method === "turn/started") {
      // A turn we did not start (a drained queue submission) still becomes a
      // real kernel turn so its events and completion are attributable.
      if (kernel.active() === null) {
        const startedTurn = asRecord(params.turn)?.id;
        const kernelTurn = kernel.begin();
        if (kernelTurn !== null && typeof startedTurn === "string") {
          current = { kernelTurn, codexTurnId: Promise.resolve(startedTurn) };
        }
      }
      return;
    }
    const state = current;
    if (state === null || state.kernelTurn.settled()) {
      return;
    }
    const turn = state.kernelTurn;
    switch (method) {
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string") {
          turn.emit({ kind: "text_delta", text: params.delta });
        }
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (typeof params.delta === "string") {
          turn.emit({ kind: "thinking_delta", text: params.delta });
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        const itemType = typeof item?.type === "string" ? item.type : "";
        const itemId = typeof item?.id === "string" ? item.id : "unknown";
        if (TOOL_ITEM_TYPES.has(itemType)) {
          if (method === "item/started") {
            turn.emit({ kind: "tool_call_started", callId: itemId, tool: itemType });
          } else {
            turn.emit({ kind: "tool_call_ended", callId: itemId });
          }
        }
        break;
      }
      case "turn/completed": {
        const outcome = outcomeFromStatus(asRecord(params.turn)?.status);
        if (outcome.kind === "failed" && lastErrorDetail !== null) {
          const reason = `${outcome.reason}: ${lastErrorDetail}`;
          turn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        } else {
          turn.settle(outcome);
        }
        lastErrorDetail = null;
        break;
      }
      case "error": {
        const error = asRecord(params.error);
        const message = typeof error?.message === "string" ? error.message : "";
        const details = typeof error?.additionalDetails === "string" ? error.additionalDetails : "";
        const combined = [message, details].filter((part) => part.length > 0).join(" — ");
        if (combined.length > 0) {
          lastErrorDetail = combined;
        }
        break;
      }
      default:
        break;
    }
  });
  client.onExit(() => {
    if (!disposed) {
      kernel.active()?.settle({ kind: "failed", reason: "codex app-server exited", failure: "runtime_exited" });
    }
  });

  const makeTurn = (state: CodexTurnState): Turn => ({
    id: state.kernelTurn.id,
    outcome: state.kernelTurn.outcome,
    abort: async () => {
      if (state.kernelTurn.settled()) {
        return;
      }
      const codexTurnId = await state.codexTurnId;
      if (!state.kernelTurn.settled()) {
        try {
          await client.request("turn/interrupt", { threadId, turnId: codexTurnId });
        } catch {
          // The turn ended before the interrupt landed — the contractual late
          // abort no-op; turn/completed settles the real outcome.
        }
        await state.kernelTurn.outcome;
      }
    },
    steer: async (input) => {
      if (state.kernelTurn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      const codexTurnId = await state.codexTurnId;
      try {
        await client.request("turn/steer", {
          threadId,
          input: [{ type: "text", text: input }],
          expectedTurnId: codexTurnId,
        });
        return { kind: "accepted" };
      } catch (error) {
        return { kind: "not_steerable", reason: error instanceof Error ? error.message : "rejected" };
      }
    },
  });

  const session: Session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const kernelTurn = kernel.begin();
      if (kernelTurn === null) {
        return { kind: "busy" };
      }
      const codexTurnId = (async (): Promise<string> => {
        const response = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input }],
        });
        const turnId = asRecord(response.turn)?.id;
        if (typeof turnId !== "string") {
          throw new TypeError("codex turn/start returned no turn id");
        }
        return turnId;
      })();
      void (async (): Promise<void> => {
        try {
          await codexTurnId;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "turn/start failed";
          kernelTurn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        }
      })();
      const state: CodexTurnState = { kernelTurn, codexTurnId };
      current = state;
      return { kind: "turn", turn: makeTurn(state) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    queue: {
      durable: true,
      add: async (input) => {
        await client.request("thread/queue/add", {
          threadId,
          input: [{ type: "text", text: input }],
          clientUserMessageId: randomUUID(),
        });
      },
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      client.kill();
      // Await the actual exit: the process may hold state (codex's sqlite
      // runtime in CODEX_HOME) that the next session needs released.
      await client.exited;
    },
  });
  return session;
};
