import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitIdle, promptAndWait, runtimeBrandIcon, runtimes, type Session } from "../../packages/oar/src/index.js";
import { parseMove, type Move } from "./game.js";
import { parseReply, systemPrompt, type Corner } from "./prompts.js";

export interface Reply {
  readonly move: Move | null;
  readonly taunt: string;
  readonly ms: number;
  /** Set when the turn did not end normally: a timeout, a failed turn, a rejected prompt. */
  readonly trouble?: string;
}

export interface Vitals {
  readonly model: string | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly contextPercent: number | null;
}

/** What the referee needs from a contestant. The oar-backed one below is the only place a runtime appears. */
export interface Fighter {
  readonly name: string;
  readonly icon: string | null;
  choose(prompt: string, onThought: (text: string) => void, timeoutMs: number): Promise<Reply>;
  heckle(text: string): Promise<string>;
  vitals(): Vitals;
  dispose(): Promise<void>;
}

export interface FighterSpec {
  readonly runtimeId: string;
  readonly model?: string;
}

/** `claude`, `codex:gpt-5.2`, `mock`, or `mock:claude` for a mock wearing a runtime's brand. */
export function parseFighterSpec(spec: string): FighterSpec {
  const [runtimeId = "", ...rest] = spec.split(":");
  const model = rest.join(":");
  return model === "" ? { runtimeId } : { runtimeId, model };
}

export function displayName(spec: FighterSpec): string {
  if (spec.runtimeId !== "mock") {
    return runtimes.require(spec.runtimeId).brand.name;
  }
  return spec.model === undefined ? "Mock" : `${runtimes.require(spec.model).brand.name} (mock)`;
}

export async function openFighter(spec: FighterSpec, corner: Corner): Promise<Fighter> {
  if (spec.runtimeId === "mock") {
    return mockFighter(corner.name, spec.model === undefined ? null : runtimeBrandIcon(runtimes.require(spec.model).brand, "dark"));
  }
  const runtime = runtimes.require(spec.runtimeId);
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") {
    throw new Error(`${spec.runtimeId} is not available on this machine`);
  }
  // Sessions run YOLO; an empty scratch directory keeps a fighter that reaches for tools anyway away from real files.
  const cwd = await mkdtemp(join(tmpdir(), `oar-arena-${spec.runtimeId}-`));
  const session = await runtime.session(installation, {
    cwd,
    systemPrompt: systemPrompt(corner),
    ...(spec.model === undefined ? {} : { model: spec.model }),
  });
  return sessionFighter(session, corner.name, runtimeBrandIcon(runtime.brand, "dark"), cwd);
}

function sessionFighter(session: Session, name: string, icon: string | null, cwd: string): Fighter {
  return {
    name,
    icon,
    async choose(prompt, onThought, timeoutMs) {
      const started = Date.now();
      const unsubscribe = session.events((event) => {
        if (event.agentPath.length > 0) {
          return;
        }
        if (event.kind === "text_delta") {
          onThought(event.text);
        } else if (event.kind === "reasoning" && event.content.kind === "text") {
          onThought(event.content.text);
        } else if (event.kind === "tool_call_started") {
          onThought(`\n[${event.tool}]\n`);
        }
      });
      try {
        // A shout steered in after the model's last step runs as a turn of its own; the round's prompt waits that turn out.
        let run = await promptAndWait(session, prompt, { timeoutMs });
        while (run.kind === "rejected" && run.code === "busy" && Date.now() - started < timeoutMs) {
          await awaitIdle(session);
          run = await promptAndWait(session, prompt, { timeoutMs: timeoutMs - (Date.now() - started) });
        }
        const ms = Date.now() - started;
        if (run.kind === "rejected") {
          return { move: null, taunt: "", ms, trouble: `prompt ${run.code}` };
        }
        if (run.kind === "interrupted") {
          return { move: null, taunt: "", ms, trouble: "timed out" };
        }
        if (run.outcome.kind !== "completed") {
          return { move: null, taunt: "", ms, trouble: run.outcome.kind === "failed" ? run.outcome.reason : "aborted" };
        }
        const reply = parseReply(run.text);
        return { move: parseMove(reply?.move), taunt: reply?.taunt ?? "", ms };
      } finally {
        unsubscribe();
      }
    },
    async heckle(text) {
      // Steer only: a queued shout would run as a turn of its own and make the referee's next prompt `busy`.
      if (session.steer === undefined) {
        return "ignored (this runtime cannot steer)";
      }
      const shout = await session.steer(`[CROWD] ${text}`);
      return shout.kind === "accepted" ? "steered" : `missed (${shout.code})`;
    },
    vitals() {
      return {
        model: session.model().value,
        tokens: session.usage().value.total,
        contextPercent: session.contextUsage().value?.percent ?? null,
      };
    },
    async dispose() {
      await session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

const MOCK_THOUGHTS = [
  "They blocked last round, so the sandbox is stale now.",
  "Low on tokens. Patience.",
  "A heavy hit is coming, I can feel it.",
  "If I strike first this could end here.",
];

/** Offline contestant for working on the stage without spending real turns: picks at random from what the prompt says it can afford. */
function mockFighter(name: string, icon: string | null): Fighter {
  return {
    name,
    icon,
    async choose(prompt, onThought, _timeoutMs) {
      const started = Date.now();
      const thought = MOCK_THOUGHTS[Math.floor(Math.random() * MOCK_THOUGHTS.length)] ?? "";
      for (const word of thought.split(" ")) {
        // eslint-disable-next-line no-await-in-loop
        await delay(40 + Math.random() * 80);
        onThought(`${word} `);
      }
      const affordable = (/You can afford: (?<moves>.*)/u.exec(prompt)?.groups?.moves ?? "patch").split(", ");
      const move = parseMove(affordable[Math.floor(Math.random() * affordable.length)]) ?? "patch";
      onThought(`\n{"move":"${move}"}`);
      return { move, taunt: "beep boop", ms: Date.now() - started };
    },
    heckle: async () => { await Promise.resolve(); return "ignored (mock)"; },
    vitals: () => ({ model: "mock", tokens: null, contextPercent: null }),
    dispose: async () => { await Promise.resolve(); },
  };
}
