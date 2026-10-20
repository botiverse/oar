import type { JsonRecord } from "../../shared/json.js";
import { CLAUDE_EFFORT_READBACK_MS } from "./effort.js";

/** Internal limits, injectable by native tests without adding a host option. */
export interface ClaudeOpenLimits {
  readonly readbackMs: number;
  readonly hookMs: number;
}

export const claudeOpenLimits: ClaudeOpenLimits = {
  readbackMs: CLAUDE_EFFORT_READBACK_MS,
  hookMs: 600_000,
};

interface Waiting {
  readonly method: string;
  readonly expire: (error: Error) => void;
  remainingMs: number;
}

/**
 * Only native root SessionStart reports suspend opening readbacks. Overlapping
 * hooks consume wall time once; the pause allowance spans every open readback.
 * Hook output is never used to explain a deadline failure.
 */
export class ClaudeOpenDeadline {
  private readonly hooks = new Map<string, string>();
  private readonly seen = new Set<string>();
  private pausedMs = 0;
  private updatedAt = performance.now();
  private waiting: Waiting | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly limits: ClaudeOpenLimits) {}

  start(method: string, expire: (error: Error) => void): void {
    this.account();
    this.waiting = { method, expire, remainingMs: this.limits.readbackMs };
    this.arm();
  }

  stop(): void {
    this.account();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting = null;
  }

  consume(message: JsonRecord): void {
    if (message.type !== "system" || message.hook_event !== "SessionStart"
      || typeof message.parent_tool_use_id === "string" || typeof message.hook_id !== "string") { return; }
    if (message.subtype !== "hook_started" && message.subtype !== "hook_response") { return; }
    this.account();
    this.arm();
    if (message.subtype === "hook_response") {
      this.hooks.delete(message.hook_id);
    } else if (!this.seen.has(message.hook_id)) {
      this.seen.add(message.hook_id);
      this.hooks.set(message.hook_id, typeof message.hook_name === "string" ? message.hook_name : "SessionStart");
    }
    this.arm();
  }

  private account(): void {
    const now = performance.now();
    const elapsed = Math.max(0, now - this.updatedAt);
    if (this.hooks.size > 0) { this.pausedMs += elapsed; }
    else if (this.waiting !== null) { this.waiting.remainingMs -= elapsed; }
    this.updatedAt = now;
  }

  private arm(): void {
    clearTimeout(this.timer);
    const waiting = this.waiting;
    if (waiting === null) { return; }
    const paused = this.hooks.size > 0;
    const remaining = paused ? this.limits.hookMs - this.pausedMs : waiting.remainingMs;
    if (remaining <= 0) {
      this.waiting = null;
      const message = paused
        ? `claude SessionStart hooks exceeded the ${String(this.limits.hookMs)} ms opening pause budget while waiting for ${waiting.method}; still running: ${[...new Set(this.hooks.values())].join(", ")}`
        : `claude did not answer ${waiting.method} within ${String(this.limits.readbackMs)} ms`;
      waiting.expire(new Error(message));
      return;
    }
    this.timer = setTimeout(() => { this.account(); this.arm(); }, remaining);
  }
}
