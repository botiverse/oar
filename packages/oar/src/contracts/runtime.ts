/* oxlint-disable import/max-dependencies -- Runtime composes the independently owned capability contracts. */
import type { AccountUsageReader, LimitResetInspector, LimitResetRedeemer } from "./account-usage.js";
import type { AuthStatusReader, RuntimeLogin, RuntimeLogout } from "./login.js";
import type { AvailableInstallation, InstallationProbe } from "./installation.js";
import type { InstallLine, InstallPlanner, Installer } from "./install.js";
import type { InventoryResult, RuntimeInventories } from "./inventory.js";
import type { McpTransport, SessionOptions } from "./session-options.js";
// oxlint-disable-next-line import/consistent-type-specifier-style -- Keep types and implementation from the same contract in one import.
import { type PlacementRequest, type RuntimePlacementOptions, placementSession } from "./placement.js";
import type { UpdateChecker, Upgrader } from "./update.js";
import type { AskSideQuestion } from "./side-question.js";
import type { ContextUsageCapability } from "./context-usage.js";
import type { ManualCompaction } from "./compaction.js";
import type { ModelLister } from "./list-models.js";
import type { ProviderAuthReader } from "./provider-auth.js";
import type { RuntimeBrand } from "./brand.js";
import type { RuntimeCredentials } from "./credentials.js";
import type { StartSession } from "./session.js";
import type { TaskType } from "./tasks.js";
import { UnsupportedOptionError } from "./errors.js";

/**
 * The `SessionOptions` a runtime can refuse at open. `mcpServerCredentials`
 * identifies a value of an option a host can know in advance: an
 * `mcpServers` entry carrying a credential (a non-empty `env` on a stdio
 * entry, non-empty `headers` on an http one), which every `serveMcpTools`
 * entry does. Declare it when isolation through the first turn is unverified or fails
 * (docs/spec/runtime-matrix.md#refused-session-options).
 * `userConfiguration` refuses any nonempty exclusion;
 * `partialUserConfiguration` refuses a nonempty proper subset;
 * `"include"` and omission keep native behavior. `fork` is any
 * `SessionOptions.fork`, with or without `through`.
 */
export type RefusableSessionOption = "systemPrompt" | "appendSystemPrompt" | "env" | "mcpServers" | "mcpServerCredentials" | "disallowedTools" | "launchArgs" | "serviceTier" | "additionalDirectories" | "outputSchema" | "name" | "userConfiguration" | "partialUserConfiguration" | "goals" | "endTurnProcessesOnAbort" | "fork" | "nativeMemoryDefault" | "sessionLogUpload" | "modelRequests" | "questions" | "piProvider" | "piCompaction";

/**
 * The options a runtime refuses when they are given (`env`, `mcpServers`, `disallowedTools`, `launchArgs`, `additionalDirectories`: a
 * non-empty one; `mcpServerCredentials`: an entry carrying one; `userConfiguration`: any exclusion), each with the reason `session()` rejects with, in the message of an
 * `UnsupportedOptionError` naming the option (`mcpServers` for `mcpServerCredentials`). Unlisted options can still have value-specific refusals (for example,
 * a tool name the native filter cannot disable); see the runtime page.
 */
export type RefusedSessionOptions = Readonly<Partial<Record<RefusableSessionOption, string>>>;

/**
 * Capabilities known before open. A missing field is unknown. The session reports what the handshake establishes.
 * `installedSessionCapabilities` and `defineRuntime` combine static and version-specific refusals and manual
 * compaction declarations. Every declared refusal applies at open.
 */
export interface SessionCapabilityDeclaration {
  readonly sideQuestion?: boolean; // Can ask once from a discarded native fork of a stored session.
  readonly steer?: boolean;
  readonly images?: boolean;
  readonly refusedSessionOptions?: RefusedSessionOptions;
  readonly manualCompaction?: ManualCompaction;
  /** Whether native automatic compaction reports `compaction_started` / `compaction_ended`; absent when unmeasured. */
  readonly compactionEvents?: CompactionEvents;
  /** Whether `Session.contextUsage()` reports `tokens` and `contextWindow` by the end of a completed turn (exceptions on `ContextUsageCapability`); absent when unmeasured. */
  readonly contextUsage?: ContextUsageCapability;
  /** Verified session MCP transports (`[]` when MCP is refused; absent when unverified or handshake-only). */
  readonly mcpTransports?: readonly McpTransport[];
  /** Per-server native startup reports are available before input. A first model request may run while discovery is pending. */
  readonly mcpStartup?: { readonly kind: "per_server"; readonly firstModelRequest: "may_start_pending" };
  /** Observed native task classes with lifecycle events. An empty array means this adapter has no task projection. */
  readonly taskEventTypes?: readonly TaskType[];
  /** Where the host can read the child's own result. Omitted modes are unverified. */
  readonly subagentResults?: {
    /** The parent tool result contains child output before the originating turn ends. */
    readonly foreground?: "parent_tool_result";
    /** Child output can arrive at completion without another host input, including between parent turns. */
    readonly background?: "child_text" | "task_output";
  };
  /** Whether an opened session exposes `Session.stopTask(taskId)`. */
  readonly stopTask?: boolean;
  /** Whether an opened session exposes `Session.answer` (`capabilities.appRequests` says what it accepts). */
  readonly answer?: boolean;
  /** Whether an opened session exposes `Session.answerQuestion`: the runtime's own questions can go to the host. */
  readonly questions?: boolean;
  /** A completed native file-edit tool can report applied changes by path and kind. */
  readonly fileChanges?: boolean;
  /** Whether the session can locate its native persisted file. */
  readonly nativeSessionFile?: boolean;
}

/** Which compaction lifecycle events a runtime's own automatic compaction produces. */
export interface CompactionEvents {
  readonly started: boolean;
  readonly ended: boolean;
}

/** `process.platform` values a runtime can be verified on. */
export type RuntimePlatform = "linux" | "darwin" | "win32";

/** Native behavior of an accepted option when reopening a saved session. */
export interface ResumeOptionSemantics {
  /** When a supplied value DIFFERENT from the saved value takes effect. */
  readonly provided: "immediate" | "next_compaction";
  /**
   * Without the option: `saved` retains the saved value; `default` uses what
   * a new session without this option would get, including user configuration;
   * `saved_until_compaction` retains the saved value until native compaction,
   * then uses that default.
   */
  readonly omitted: "saved" | "default" | "saved_until_compaction";
}

/**
 * Measured resume semantics, keyed by SessionOptions for future additions.
 * An absent entry means untested, not refused or supported. Refused options
 * belong in RefusedSessionOptions; value/state-specific refusals still apply.
 */
export type ResumedSessionOptions = Readonly<Partial<Record<keyof SessionOptions, ResumeOptionSemantics>>>;

/**
 * Whether a running session's model sees a change an attached MCP server
 * announces with `notifications/tools/list_changed` (#399), judged by the
 * session's next model request: `full`, added tools appear and removed ones
 * disappear; `additions`, added tools appear while removed ones stay offered
 * (a call to one fails as an unknown tool); `none`, the session keeps the
 * tools it listed when it opened. A change the session does not take applies
 * when the host opens its next session.
 */
export type McpToolsListChanged = "full" | "additions" | "none";

/** One provider-independent runtime adoption unit. */
export interface Runtime extends RuntimeInventories {
  /** Static adapter declaration, independent of installation version. Null means undeclared. */
  readonly execution: "process" | "in_process" | null;
  /** Requested policy. The opened Session reports what actually ran. */
  readonly placement: PlacementRequest;
  /** A new runtime instance, with its own pool. Refusals are checked at session open. */
  withPlacement(placement: PlacementRequest): Runtime;
  readonly id: string;
  /** Minimum native version required by this adapter, when it has a numeric floor. Individual capabilities may require newer versions. Absence means no declared floor, not support for every version. */
  readonly minVersion?: string;
  readonly brand: RuntimeBrand;
  /** Operating systems where OAR's behavior suite ran this runtime's real binary or SDK. Absent: not verified in CI, which is unknown, not unsupported. */
  readonly verifiedPlatforms?: readonly RuntimePlatform[];
  readonly credentials?: RuntimeCredentials;
  readonly sideQuestion?: AskSideQuestion;
  readonly session: StartSession; // the core capability: a runtime without sessions is not usable
  /**
   * Declared before any session opens, so a host leaves a refused option out
   * without knowing runtimes by name. `session()` checks the same map, so a
   * declared option is always refused (an `UnsupportedOptionError`) and a
   * refused one always declared. A refusal only the runtime can decide at
   * open (kimi's directory for a resume) is not declared here but is the
   * same error.
   */
  readonly refusedSessionOptions?: RefusedSessionOptions;
  /**
   * How accepted options behave on resume, declared before opening. Omitted
   * entries are untested. Native vendor regressions verify each declaration;
   * this does not inject prompts, compare values or change native timing.
   * Codex declarations were verified with local compaction; ChatGPT remote
   * compaction has only been inspected in native source, not exercised.
   */
  readonly resumedSessionOptions?: ResumedSessionOptions;
  /**
   * Manual compaction before opening; absence means untested, not unsupported.
   * The opened session member expresses actual availability. Codex has native
   * local-compaction tests; ChatGPT remote compaction has source evidence only.
   */
  readonly manualCompaction?: ManualCompaction;
  /**
   * How a running session takes a change to an attached MCP server's tools
   * (any server that sends `notifications/tools/list_changed`, such as
   * `ServedMcpTools.setTools`), declared before any session opens. Absent
   * when the runtime takes no `mcpServers` or was not measured
   * (experiments/mcp-tools-list-changed.ts, docs/spec/runtime-matrix.md#host-served-tools).
   */
  readonly mcpToolsListChanged?: McpToolsListChanged;
  /**
   * Pure and synchronous: no process, no I/O. Takes the installation because
   * the answer can depend on its version (OpenCode 1 vs 2). Runtimes built
   * with `defineRuntime` always have it, with the static declarations merged
   * in (docs/spec/runtime-matrix.md#session-capabilities-before-open).
   */
  readonly sessionCapabilities?: (installation: AvailableInstallation) => SessionCapabilityDeclaration;
  readonly installation?: InstallationProbe;
  /** Read only: what `install` would run here, or why it would run nothing. Present exactly when `install` is. */
  readonly installPlan?: InstallPlanner;
  /**
   * Runs the runtime's own installer when `installation` finds none, judged by
   * `installation` afterwards; changes the machine, so only on the host's
   * explicit call. Absent when there is nothing to install (a bundled SDK).
   */
  readonly install?: Installer;
  /**
   * Declared by a runtime whose vendor ships parallel release lines of one
   * command (opencode: `v1`, `v2`), so a host offers the choice before
   * planning: `installPlan` and `install` take one as `options.line` and
   * answer `line_required` without it. Absent for a runtime with one line.
   */
  readonly installLines?: readonly InstallLine[];
  readonly accountUsage?: AccountUsageReader;
  /** Spends one of the account's limit resets (`limitResets` in `accountUsage`); uses up the account owner's reset, so only on the host's explicit call. */
  readonly redeemLimitReset?: LimitResetRedeemer;
  /**
   * Lists the account's limit resets through the runtime's interactive UI
   * (claude); not a passive read and can spend on Claude's older program, so
   * only on the account owner's explicit request, never polled.
   *
   * A call that launches Claude Code's interactive UI costs a model request
   * (claude): the UI sends one at startup (seen in oar's offline harness). A
   * call that returns before launching sends nothing. On a subscription that
   * request is reported to count as usage and may start an idle account's
   * 5-hour window (a third-party report for 2.1.316; not measured by oar). `/limit-reset` has no `-p`, SDK or
   * control-protocol form (2.1.322), so there is no route without the UI.
   * `redeemLimitReset` starts the UI the same way.
   */
  readonly inspectLimitResets?: LimitResetInspector;
  readonly listModels?: ModelLister;
  /** Read only: the version the runtime's own updater would install. */
  readonly checkUpdate?: UpdateChecker;
  /** Runs the runtime's own updater; changes the machine, so only on the host's explicit call. */
  readonly upgrade?: Upgrader;
  /** Signs the runtime in through its own login; changes the machine's credentials, so only on the host's explicit call. */
  readonly login?: RuntimeLogin;
  /** Signs the runtime out through its own logout, confirmed by its status query; changes the machine's credentials, so only on the host's explicit call. */
  readonly logout?: RuntimeLogout;
  /** Whether the runtime is signed in, from its native status query; may refresh credentials. */
  readonly authStatus?: AuthStatusReader;
  /** Provider-level credential observations for runtimes with multiple accounts. */
  readonly providers?: ProviderAuthReader;
}

async function unsupported(): Promise<InventoryResult<never>> {
  await Promise.resolve();
  return {
    kind: "unsupported",
    code: "transport_unavailable",
    reason: "The selected runtime interface does not expose this inventory",
  };
}

type RuntimeDefinition = Omit<Runtime, keyof RuntimeInventories | "brand" | "execution" | "placement" | "withPlacement"> & Partial<RuntimeInventories> & { readonly brand?: RuntimeBrand };
type DefinedRuntime<T> = Omit<T, "session" | "execution" | "placement" | "withPlacement" | "sessionCapabilities"> & Runtime & { readonly sessionCapabilities: NonNullable<Runtime["sessionCapabilities"]> };

export function defineRuntime<const T extends RuntimeDefinition>(runtime: T, options: RuntimePlacementOptions = {}): DefinedRuntime<T> {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JavaScript callers can bypass the discriminated options.
  if (options.shared !== undefined && options.execution !== "process") { throw new Error("Shared placement requires execution: process"); }
  const create = (requested: PlacementRequest): DefinedRuntime<T> => {
    const open = placementSession(runtime.session, requested, options);
    return {
      skills: unsupported, commands: unsupported, mcpServers: unsupported, tools: unsupported,
      ...runtime, brand: runtime.brand ?? { name: runtime.id, icon: null }, placement: requested,
      // Static declarations come from the object it is called on, so a host that spreads this runtime and
      // replaces `refusedSessionOptions` or `manualCompaction` gets its own; a detached call uses this definition's.
      sessionCapabilities(this: StaticDeclarations | undefined, installation: AvailableInstallation): SessionCapabilityDeclaration {
        return withStaticDeclarations(this ?? runtime, runtime.sessionCapabilities?.(installation) ?? {});
      },
      execution: options.execution ?? null,
      withPlacement: create,
      // `questions` is opt-in per runtime: a runtime that has not verified a
      // host-answered question channel refuses it rather than dropping it.
      session: async (installation, sessionOptions, context) => {
        if (sessionOptions.questions !== undefined && runtime.sessionCapabilities?.(installation).questions !== true) {
          throw new UnsupportedOptionError("questions", "This runtime has no verified host-answered question channel");
        }
        const opened = await open(installation, sessionOptions, context);
        return opened;
      },
    };
  };
  return create("auto");
}

type StaticDeclarations = Pick<Runtime, "refusedSessionOptions" | "manualCompaction">;

function withStaticDeclarations(statics: StaticDeclarations, declared: SessionCapabilityDeclaration): SessionCapabilityDeclaration {
  const refused = { ...statics.refusedSessionOptions, ...declared.refusedSessionOptions };
  const manualCompaction = declared.manualCompaction ?? statics.manualCompaction;
  return {
    ...declared,
    ...(Object.keys(refused).length === 0 ? {} : { refusedSessionOptions: refused }),
    ...(manualCompaction === undefined ? {} : { manualCompaction }),
  };
}

/**
 * A runtime's answer for one installation, with its static
 * `refusedSessionOptions` and `manualCompaction` merged under what the
 * installation adds. Works for any `Runtime`, including one built without
 * `defineRuntime`. A version-dependent refusal belongs only in the
 * installation's answer: whatever the static map refuses, every version
 * refuses.
 */
export function installedSessionCapabilities(runtime: StaticDeclarations & Pick<Runtime, "sessionCapabilities">, installation: AvailableInstallation): SessionCapabilityDeclaration {
  return withStaticDeclarations(runtime, runtime.sessionCapabilities?.(installation) ?? {});
}
