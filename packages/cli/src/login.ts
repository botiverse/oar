import { createInterface, type Interface } from "node:readline/promises";
import type { Command } from "commander";
import type {
  AuthStatus,
  InstallationSnapshot,
  LoginResult,
  ProviderLoginEvent,
  ProviderLoginInteraction,
  ProviderLoginPrompt,
  Runtime,
} from "@botiverse/oar";

// Pure shapes of `oar login` output, so the action stays a print loop and the
// mapping can be pinned by tests without running any login.
export interface AuthStatusReport {
  readonly runtimeId: string;
  /** Present only when the runtime is installed but not `available`. */
  readonly installation?: InstallationSnapshot;
  readonly status?: AuthStatus;
  /** Why the runtime offers no status query. */
  readonly unsupported?: string;
  /** The probe or the status query threw; the other runtimes are still reported. */
  readonly error?: string;
}

export interface LoginReport {
  readonly runtimeId: string;
  readonly installation?: InstallationSnapshot;
  readonly result?: LoginResult;
  readonly unsupported?: string;
  readonly error?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readAuthStatus(runtime: Runtime, timeoutMs?: number): Promise<AuthStatusReport> {
  const runtimeId = runtime.id;
  try {
    if (runtime.installation === undefined) {
      return { runtimeId, unsupported: `${runtimeId} exposes no installation probe` };
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      return { runtimeId, installation };
    }
    if (runtime.authStatus === undefined) {
      return { runtimeId, unsupported: `${runtimeId} exposes no sign-in status query` };
    }
    return { runtimeId, status: await runtime.authStatus(installation, timeoutMs === undefined ? {} : { timeoutMs }) };
  } catch (error) {
    return { runtimeId, error: message(error) };
  }
}

export async function runLogin(runtime: Runtime, interaction: ProviderLoginInteraction, timeoutMs?: number): Promise<LoginReport> {
  const runtimeId = runtime.id;
  try {
    if (runtime.installation === undefined) {
      return { runtimeId, unsupported: `${runtimeId} exposes no installation probe` };
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      return { runtimeId, installation };
    }
    if (runtime.login === undefined) {
      return { runtimeId, unsupported: `${runtimeId} has no login oar can drive` };
    }
    return { runtimeId, result: await runtime.login(installation, interaction, timeoutMs === undefined ? {} : { timeoutMs }) };
  } catch (error) {
    return { runtimeId, error: message(error) };
  }
}

function accountLabel(account: { readonly email?: string; readonly plan?: string; readonly method?: string } | undefined): string {
  if (account === undefined) {
    return "";
  }
  const notes = [account.method, account.plan].filter((note) => note !== undefined);
  return `${account.email === undefined ? "" : ` as ${account.email}`}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

export function renderAuthStatus(report: AuthStatusReport): string {
  const { runtimeId } = report;
  if (report.error !== undefined) {
    return `${runtimeId}\terror: ${report.error}`;
  }
  if (report.installation !== undefined) {
    return `${runtimeId}\tnot available (${report.installation.kind})`;
  }
  const { status } = report;
  if (status === undefined) {
    return `${runtimeId}\t${report.unsupported ?? "no status"}`;
  }
  switch (status.kind) {
    case "signed_in":
      return `${runtimeId}\tsigned in${accountLabel(status.account)}`;
    case "signed_out":
      return `${runtimeId}\tsigned out`;
    case "unknown":
      break;
  }
  return `${runtimeId}\tstatus unknown${status.detail === undefined ? "" : ` (${status.detail})`}`;
}

export function renderLoginEvent(event: ProviderLoginEvent): string[] {
  switch (event.kind) {
    case "auth_url":
      return [event.instructions ?? "Open this URL to sign in:", `  ${event.url}`];
    case "device_code":
      return [
        `Open ${event.verificationUri} and enter this code${event.expiresInSeconds === undefined ? "" : ` (expires in ${String(event.expiresInSeconds)} s)`}:`,
        `  ${event.userCode}`,
      ];
    case "info":
      break;
  }
  return [event.message];
}

export function renderLoginReport(report: LoginReport): string {
  const { runtimeId, result } = report;
  if (report.error !== undefined) {
    return `${runtimeId}\terror: ${report.error}`;
  }
  if (report.installation !== undefined) {
    return `${runtimeId}\tnot available (${report.installation.kind})`;
  }
  if (result === undefined) {
    return `${runtimeId}\t${report.unsupported ?? "no login"}`;
  }
  switch (result.kind) {
    case "logged_in":
      return `${runtimeId}\tsigned in${accountLabel(result.account)}`;
    case "cancelled":
      return `${runtimeId}\tlogin cancelled`;
    case "failed":
      return `${runtimeId}\tlogin failed: ${result.reason}${result.detail === undefined ? "" : ` (${result.detail})`}`;
    case "unsupported":
      break;
  }
  return `${runtimeId}\tlogin unsupported: ${result.reason}${result.detail === undefined ? "" : ` (${result.detail})`}`;
}

/** 0 signed in, 130 cancelled (as for Ctrl-C), 1 otherwise. */
export function loginExitCode(report: LoginReport): number {
  if (report.result?.kind === "logged_in") {
    return 0;
  }
  return report.result?.kind === "cancelled" ? 130 : 1;
}

function promptText(prompt: ProviderLoginPrompt): string {
  if (prompt.kind !== "select") {
    return `${prompt.message}${prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`}: `;
  }
  const options = prompt.options.map((option, index) => `  ${String(index + 1)}. ${option.label}${option.description === undefined ? "" : ` - ${option.description}`}`);
  return `${[prompt.message, ...options].join("\n")}\nChoose a number: `;
}

/** A select answer is an option id; a person types its number or the id itself. */
export function selectAnswer(prompt: ProviderLoginPrompt, typed: string): string {
  if (prompt.kind !== "select") {
    return typed;
  }
  const answer = typed.trim();
  return prompt.options[Number(answer) - 1]?.id ?? answer;
}

interface TerminalInteraction extends ProviderLoginInteraction {
  close(): void;
}

function write(text: string): void {
  process.stdout.write(text);
}

/** Events and prompts on the terminal; Ctrl-C aborts. With `json`, events and prompts are JSON lines on stdout. */
function terminalInteraction(abort: AbortController, json: boolean): TerminalInteraction {
  let lines: Interface | null = null;
  // Input that ends (a closed pipe, Ctrl-D) fails the open prompt instead of leaving the login waiting.
  let ended = false;
  let onEnd: (() => void) | null = null;
  const open = (): Interface => {
    if (lines === null) {
      lines = createInterface({ input: process.stdin, output: json ? process.stderr : process.stdout });
      // While it reads a terminal, Ctrl-C arrives as this event rather than a signal.
      lines.on("SIGINT", () => {
        abort.abort();
      });
      lines.on("close", () => {
        ended = true;
        onEnd?.();
      });
    }
    return lines;
  };
  return {
    signal: abort.signal,
    onEvent(event) {
      write(json ? `${JSON.stringify({ event })}\n` : `${renderLoginEvent(event).join("\n")}\n`);
    },
    async prompt(prompt) {
      if (json) {
        write(`${JSON.stringify({ prompt })}\n`);
      }
      const reader = open();
      if (ended) {
        throw new Error("input ended before an answer");
      }
      const end = Promise.withResolvers<string>();
      onEnd = (): void => {
        end.reject(new Error("input ended before an answer"));
      };
      try {
        const typed = await Promise.race([reader.question(json ? "" : promptText(prompt), { signal: abort.signal }), end.promise]);
        if (!json && !process.stdin.isTTY) {
          // Piped input is not echoed; end the prompt's line anyway.
          write("\n");
        }
        return selectAnswer(prompt, typed);
      } finally {
        onEnd = null;
      }
    },
    close() {
      lines?.close();
    },
  };
}

/** `oar login [runtime]`: sign a runtime in through its own login; `--status` only reports. */
export function registerLoginCommand(program: Command, selected: (id: string | undefined) => readonly Runtime[]): void {
  program
    .command("login [runtime]")
    .description("Sign a runtime in through its own login; --status only reports whether each is signed in")
    .option("--status", "report whether each runtime is signed in, change nothing")
    .option("--json", "print events, prompts and the result as JSON lines")
    .option("--timeout <ms>", "bound for the login (or each status query) in milliseconds")
    .action(async (id: string | undefined, flags: { status?: boolean; json?: boolean; timeout?: string }) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
        process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
        process.exitCode = 1;
        return;
      }
      if (flags.status === true) {
        const reports = await Promise.all(selected(id).map(async (runtime) => {
          const report = await readAuthStatus(runtime, timeoutMs);
          return report;
        }));
        if (reports.some((report) => report.error !== undefined)) {
          process.exitCode = 1;
        }
        process.stdout.write(flags.json === true
          ? `${JSON.stringify(reports, null, 2)}\n`
          : reports.map((report) => `${renderAuthStatus(report)}\n`).join(""));
        return;
      }
      const [runtime, ...others] = id === undefined ? [] : selected(id);
      if (runtime === undefined || others.length > 0) {
        process.stderr.write("name one runtime to sign in, e.g. `oar login claude`; `oar login --status` reports them all\n");
        process.exitCode = 1;
        return;
      }
      const abort = new AbortController();
      const onInterrupt = (): void => {
        abort.abort();
      };
      process.on("SIGINT", onInterrupt);
      const interaction = terminalInteraction(abort, flags.json === true);
      const report = await runLogin(runtime, interaction, timeoutMs);
      interaction.close();
      process.off("SIGINT", onInterrupt);
      process.exitCode = loginExitCode(report);
      process.stdout.write(flags.json === true ? `${JSON.stringify({ result: report })}\n` : `${renderLoginReport(report)}\n`);
    });
}
