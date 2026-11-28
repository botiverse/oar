/* oxlint-disable import/max-dependencies -- The launch, the controls, the projection and the credential boundary meet here. */
/* oxlint-disable eslint/require-await -- Session controls return kernel promises directly. */
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import type { InputOptions, RequestRecord, ResponseBody, RuntimeEventBody, Session, SessionCapabilities, SessionOptions } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { appendCleanupFailure, cleanupFailureReason } from "../../shared/executable/process-cleanup.js";
import { sessionExitReason } from "../../shared/executable/reported-stderr.js";
import { enqueueHeld, withdrawControl } from "../../shared/held-input.js";
import { withInputImages } from "../../shared/input-images.js";
import type { JsonRecord } from "../../shared/json.js";
import { withSessionCredentials, type SessionCredentials } from "../../shared/session-credentials.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { BottegaCommandError, bottegaControl } from "./control.js";
import { bottegaCommand } from "./launch.js";
import { bottegaOpenFields, bottegaRefusedSessionOptions, type BottegaOpenFields } from "./options.js";
import { foldBottega, initialBottegaProjection } from "./projection.js";

/*
 * One OAR session is one `bottega serve` process holding one bottega session
 * (Session.id = bottega's session id), driven through its JSON lines
 * (bottega/src/serve.ts; docs/runtimes/bottega.md):
 *
 * - open: `open {cwd, provider, model, thinking, instructions}`; resume:
 *   `resume {sessionId, cwd, thinking, instructions}`. A session lives under
 *   the directory it was made for, so a resume names the same `cwd`.
 * - prompt / steer: `prompt` / `steer {text, inputId, origin}`. bottega reads
 *   `origin`: a person's input is a line of its conversation; a host's
 *   notification is an event in its inbox, which wakes the session and leaves
 *   a pointer, and which bottega's own rules may decline to start a turn for.
 *   A declined one comes back as `input_dropped`. An event signed by an app
 *   bottega has (Raft's `raft`) turns that app on in the session.
 * - abort: `cancel`. queue: held here and prompted when the turn ends.
 * - dispose: `dispose`, then the process is stopped.
 */

const OPEN_TIMEOUT_MS = 60_000;
const DISPOSE_TIMEOUT_MS = 8000;

interface Held {
  readonly body: { readonly kind: "queue"; readonly input: string } & InputOptions;
  readonly request: RequestRecord;
  readonly inputId?: string | undefined;
  accepted?: boolean;
}

function openFailure(error: unknown, sessionId: string | undefined): unknown {
  if (!(error instanceof BottegaCommandError)) { return error; }
  if (error.code === "session_not_found" && sessionId !== undefined) {
    return new SessionNotFoundError(sessionId, `bottega has no saved session ${sessionId} for this directory`, { method: "resume", native: error.native });
  }
  if (error.code === "unsupported_thinking") { return new UnsupportedOptionError("effort", error.message); }
  return error;
}

function refusalOf(error: unknown): ResponseBody {
  if (!(error instanceof BottegaCommandError)) {
    return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (error.code === "busy") { return { kind: "rejected", code: "busy", reason: "busy" }; }
  if (error.code === "no_active_turn") { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
  return { kind: "rejected", code: "runtime_refused", reason: error.message, native: error.native };
}

/** Where the session already reports its selection, a request it did not take is refused rather than run on another route. */
function refuseUnapplied(opened: JsonRecord, requested: BottegaOpenFields, resuming: boolean): void {
  if (requested.provider !== undefined && (opened.provider !== requested.provider || opened.model !== requested.model)) {
    const how = resuming ? "; a saved session keeps the model it was made with" : "";
    throw new UnsupportedOptionError("model", `bottega did not apply model ${requested.provider}/${String(requested.model)}: it reports ${String(opened.provider)}/${String(opened.model)}${how}`);
  }
  if (requested.thinking !== undefined && opened.thinking !== requested.thinking) {
    throw new UnsupportedOptionError("effort", `bottega did not apply effort ${requested.thinking}: it reports ${String(opened.thinking)}`);
  }
}

/** The input id the request carries: the host's, or the one OAR generated for it. */
function inputIdOf(request: RequestRecord): string | undefined {
  return "inputId" in request.body && typeof request.body.inputId === "string" ? request.body.inputId : undefined;
}

/** The pending prompt, given back. */
function droppedPending(request: RequestRecord, message: JsonRecord): RuntimeEventBody {
  const inputId = inputIdOf(request);
  return {
    kind: "input_dropped", reason: "runtime_refused", requestId: request.id,
    ...(inputId === undefined ? {} : { inputId }),
    ...(typeof message.reason === "string" && message.reason.length > 0 ? { message: message.reason } : {}),
  };
}

const inputFields = (text: string, inputId: string | undefined, options: InputOptions | undefined): JsonRecord => ({
  text,
  ...(inputId === undefined ? {} : { inputId }),
  ...(options?.origin === undefined ? {} : { origin: { ...options.origin } }),
});

async function open(installation: AvailableInstallation, options: SessionOptions, credentials: SessionCredentials): Promise<Session> {
  const requested = bottegaOpenFields(options);
  const launch = bottegaCommand(installation, ["serve"]);
  const child = spawnLineProcess(launch.command, launch.args, { cwd: options.cwd, env: sessionEnvironment(options.env), killTree: true, shutdown: "stdin" });
  await child.spawned;
  // Lines said before the session has its id wait for the stream that will hold them.
  const early: { readonly message: JsonRecord; readonly receivedAt: number }[] = [];
  let receive = (message: JsonRecord, receivedAt: number): void => { early.push({ message, receivedAt }); };
  const control = bottegaControl(child, (message) => { receive(message, Date.now()); });
  let opened: JsonRecord = {};
  try {
    await control.ready;
    opened = options.resume === undefined
      ? await control.request("open", { ...requested, cwd: options.cwd }, OPEN_TIMEOUT_MS)
      : await control.request("resume", { ...requested, sessionId: options.resume, cwd: options.cwd }, OPEN_TIMEOUT_MS);
    refuseUnapplied(opened, requested, options.resume !== undefined);
    if (typeof opened.sessionId !== "string" || (options.resume !== undefined && opened.sessionId !== options.resume)) {
      throw new Error(`bottega opened ${String(opened.sessionId)}, not ${options.resume ?? "a session"}`);
    }
  } catch (error) {
    child.kill();
    await child.exited;
    throw appendCleanupFailure(openFailure(error, options.resume), cleanupFailureReason(child.diagnostics().cleanup));
  }
  const sessionId = opened.sessionId;
  const kernel = credentials.kernel(sessionId);
  const capabilities: SessionCapabilities = { queue: { durable: false }, attribution: "none", images: false };
  const fallback = createAbortFallback(() => { child.kill(); });
  const held: Held[] = [];
  const route = typeof opened.provider === "string" && typeof opened.model === "string" ? `${opened.provider}/${opened.model}` : null;
  // The route the opening reported is said once, there; a step says it again only when it changes.
  let projection = { ...initialBottegaProjection, model: route };
  /** From a prompt bottega took until the turn it started ends, or the input comes back. */
  let taken = false;
  /** The prompt bottega has not yet started a turn for: what an input it gives back without an id was. */
  let pending: RequestRecord | null = null;

  const send = async (method: string, payload: JsonRecord): Promise<ResponseBody> => {
    try { return { kind: "accepted", native: await control.request(method, payload) }; }
    catch (error) { return refusalOf(error); }
  };
  const busy = (): boolean => taken || projection.turnOpen;
  const start = async (request: RequestRecord, text: string, inputOptions: InputOptions | undefined): Promise<ResponseBody> => {
    if (busy()) { return { kind: "rejected", code: "busy", reason: "busy" }; }
    // Taken before bottega answers: its turn can begin before the answer is read.
    taken = true;
    pending = request;
    const answer = await send("prompt", inputFields(text, inputIdOf(request), inputOptions));
    if (answer.kind !== "accepted" && !projection.turnOpen) {
      taken = false;
      pending = null;
    }
    return answer;
  };
  function drain(): void {
    if (busy() || kernel.unreachable() !== null) { return; }
    if (held[0]?.accepted !== true) { return; }
    const next = held.shift();
    if (next === undefined) { return; }
    void (async (): Promise<void> => {
      const { inputId: _inputId, ...body } = next.body;
      await kernel.control({ ...body, kind: "prompt", carries: [next.inputId ?? next.request.id] }, async (request): Promise<ResponseBody> => {
        const answer = kernel.unreachable() ?? await start(request, next.body.input, next.body);
        // A held input bottega refused is handed back: the queue accepted it, and nothing else would say what became of it.
        if (answer.kind === "rejected" && "native" in answer && answer.native !== undefined) {
          const dropped: RuntimeEventBody = { kind: "input_dropped", reason: "runtime_refused", message: answer.reason, requestId: request.id, ...(next.inputId === undefined ? {} : { inputId: next.inputId }) };
          kernel.frame({ type: "bottega/held_refused", native: answer.native, events: [dropped] });
        }
        return answer;
      });
      drain();
    })();
  }
  receive = (message, receivedAt): void => {
    const folded = foldBottega(projection, message);
    projection = folded.state;
    const dropped = message.type === "input_dropped";
    // bottega gives back only an input it started no turn for, the prompt still pending: one it names without an id is that one.
    const body = dropped && pending !== null && !folded.body.events.some((event) => event.kind === "input_dropped")
      ? { ...folded.body, events: [...folded.body.events, droppedPending(pending, message)] }
      : folded.body;
    if (dropped || body.events.some((event) => event.kind === "turn_active")) { pending = null; }
    const settled = dropped || body.events.some((event) => event.kind === "turn_ended");
    if (settled && !projection.turnOpen) { taken = false; }
    kernel.frame(body, { receivedAt });
    if (settled && !projection.turnOpen) {
      fallback.clear();
      drain();
    }
  };
  for (const { message, receivedAt } of early.splice(0)) { receive(message, receivedAt); }
  const opening: RuntimeEventBody[] = [
    ...(route === null ? [] : [{ kind: "model" as const, model: route }]),
    ...(typeof opened.thinking === "string" ? [{ kind: "effort" as const, effort: opened.thinking }] : []),
  ];
  kernel.frame({ type: "bottega/opened", native: opened, events: opening });
  child.onExit((code, reason) => {
    taken = false;
    pending = null;
    fallback.clear();
    held.splice(0);
    kernel.processExited(code, sessionExitReason(child, reason, credentials.redact));
  });

  return credentials.seal({
    id: sessionId, capabilities, resources: child.resources,
    prompt: async (text, inputOptions) => {
      const result = await kernel.control({ kind: "prompt", input: text, ...inputOptions }, async (request) =>
        held.length > 0 ? { kind: "rejected", code: "busy", reason: "busy" } : withInputImages(capabilities, inputOptions?.images, async () => start(request, text, inputOptions)));
      drain();
      return result;
    },
    steer: async (text, inputOptions) => kernel.control({ kind: "steer", input: text, ...inputOptions }, async (request) => {
      if (!busy()) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      return withInputImages(capabilities, inputOptions?.images, async () => send("steer", inputFields(text, inputIdOf(request), inputOptions)));
    }),
    queue: async (text, inputOptions) => {
      const body = { kind: "queue" as const, input: text, ...inputOptions };
      const result = await kernel.control(body, (request) => withInputImages(capabilities, inputOptions?.images, () => {
        enqueueHeld(held, { body, request, inputId: inputOptions?.inputId ?? inputIdOf(request) });
        return { kind: "accepted", queued: "adapter" };
      }));
      const queued = held.find((entry) => entry.request.id === result.request.id);
      if (queued !== undefined) { queued.accepted = true; }
      drain();
      return result;
    },
    withdraw: withdrawControl(kernel, held),
    abort: async () => kernel.control({ kind: "abort" }, async () => {
      if (!busy()) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      const disarm = fallback.arm();
      const answer = await send("cancel", {});
      if (answer.kind !== "accepted") { disarm(); }
      return answer;
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(), graph: () => kernel.graph(),
    dispose: async () => {
      await kernel.dispose(async () => {
        held.splice(0);
        // The process owner snapshots descendants before bottega is asked to stop, so tools it leaves are found.
        await child.prepareShutdown();
        child.markNativeStop();
        // bottega leaves its session and ends by itself; the process owner bounds that and removes anything left.
        try { await control.request("dispose", {}, DISPOSE_TIMEOUT_MS); }
        catch (error) { kernel.frame({ type: "bottega/dispose_failed", native: error instanceof BottegaCommandError ? error.native : { message: String(error) }, events: [] }); }
        child.kill();
        await child.exited;
      });
    },
  });
}

/** One owned `bottega serve` process per session, the bundled command line or the executable. */
export const bottegaSession = withSessionCredentials(async (installation, options, credentials) => {
  refuseSessionOptions(bottegaRefusedSessionOptions, options);
  return open(installation, options, credentials);
});
