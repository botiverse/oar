import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface ClockSample { readonly wallMs: number; readonly monotonicMs: number; readonly offsetMs: number }

export function clock(): ClockSample {
  const wallMs = Date.now();
  const monotonicMs = performance.now();
  return { wallMs, monotonicMs, offsetMs: wallMs - monotonicMs };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value), "Expected an observation object.");
  return value;
}

export function read(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return object(value);
}

export function write(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function waitFor(file: string, timeoutMs: number): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!existsSync(file) && performance.now() < until) {
    // eslint-disable-next-line no-await-in-loop -- Observe the fixture's own bounded readiness marker.
    await delay(20);
  }
  assert.ok(existsSync(file), `Missing fixture evidence: ${file}`);
}

export function syntheticBoundaries(): Readonly<Record<string, unknown>> {
  const floorLower = 1000;
  const tightenedLower = floorLower + 1;
  const upper = 2000;
  const oldChild = 1000.5;
  const earlyRealChild = 1000.95;
  const reusedChild = 1500;
  const samples = [{ wall: 1000, mono: 0 }, { wall: 1500, mono: 500 }, { wall: 2000, mono: 1000 }, { wall: 2500, mono: 1500 }];
  const offsets = samples.map((sample) => sample.wall - sample.mono);
  const inside = (value: number, lower: number): boolean => value > lower && value < upper;
  return {
    kind: "synthetic_counterexamples_not_native_observations",
    floorAdmitsEarlierSameMillisecondChild: inside(oldChild, floorLower),
    tightenedExcludesEarlierChild: !inside(oldChild, tightenedLower),
    tightenedAlsoExcludesHypotheticalEarlyRealChild: !inside(earlyRealChild, tightenedLower),
    heldNewRootDoesNotExcludeOldOwnerChildren: {
      oldOwnerChild: { parentPid: 1234, creationWall: 1500, creationMonotonic: 100 },
      newRoot: { pid: 1234, creationWall: 1000, creationMonotonic: 1000, handleRetained: true },
      explanation: "After a rollback before the new root, an old owner's surviving child can look newer by wall time. Holding the new root prevents later PID reuse, not this earlier reuse.",
    },
    unsampledClockRollback: {
      samples,
      maximumObservedOffsetChangeMs: Math.max(...offsets) - Math.min(...offsets),
      hiddenSample: { wall: 1500, mono: 1011, event: "after original root exit, a reused PID spawns a child during a rollback" },
      laterChildPassesTimeFilter: inside(reusedChild, tightenedLower),
    },
  };
}
