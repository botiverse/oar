import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { ProviderLoginEvent, ProviderLoginInteraction, ProviderLoginPrompt } from "@botiverse/oar";

// The terminal side of `oar login`: events printed, prompts read from stdin,
// a pasted code typed blind.

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

/** A pasted code or a secret is typed blind: the terminal does not echo it. */
export function hidesInput(prompt: ProviderLoginPrompt): boolean {
  return prompt.kind === "manual_code" || prompt.kind === "secret";
}

/**
 * The prompt reader's output, which a terminal echoes keystrokes through:
 * passed on to `target` except while `muted`.
 */
export class EchoGate extends Writable {
  muted = false;
  readonly #target: NodeJS.WritableStream;

  constructor(target: NodeJS.WritableStream) {
    super();
    this.#target = target;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      this.#target.write(chunk);
    }
    callback();
  }
}

export interface TerminalInteraction extends ProviderLoginInteraction {
  close(): void;
}

function write(text: string): void {
  process.stdout.write(text);
}

/** Events and prompts on the terminal; Ctrl-C aborts. With `json`, events and prompts are JSON lines on stdout. */
export function terminalInteraction(abort: AbortController, json: boolean): TerminalInteraction {
  let lines: Interface | null = null;
  const visible = json ? process.stderr : process.stdout;
  const echo = new EchoGate(visible);
  // Input that ends (a closed pipe, Ctrl-D) fails the open prompt instead of leaving the login waiting.
  let ended = false;
  let onEnd: (() => void) | null = null;
  const open = (): Interface => {
    if (lines === null) {
      lines = createInterface({ input: process.stdin, output: echo, terminal: process.stdin.isTTY });
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
      const hidden = hidesInput(prompt);
      const text = json ? "" : promptText(prompt);
      if (hidden) {
        // The question goes out before the gate closes; what is typed after it stays off the screen.
        visible.write(text);
        echo.muted = true;
      }
      try {
        const typed = await Promise.race([reader.question(hidden ? "" : text, { signal: abort.signal }), end.promise]);
        if (!hidden && !process.stdin.isTTY) {
          // Piped input is not echoed; end the prompt's line anyway.
          visible.write("\n");
        }
        return selectAnswer(prompt, typed);
      } finally {
        if (hidden) {
          // Nothing was echoed, the Enter included: end the prompt's line, answered or not.
          echo.muted = false;
          visible.write("\n");
        }
        onEnd = null;
      }
    },
    close() {
      lines?.close();
    },
  };
}
