/**
 * What the Mister Morph Console Runtime API actually carries for one topic:
 * submission answers, TaskInfo while polling, the `/stream/ws` snapshots, a
 * follow-up in the same topic, a steer (text submitted to a busy topic) and a
 * stop. Raw `fetch` + undici WebSocket, no OAR machinery.
 *
 * Attaches to the Console already running for the state directory (its
 * `console/runtime.json`); start one with `morph console` first. Burns a few
 * model calls on the Console's default or the given LLM profile and deletes
 * the topic it created at the end unless `--keep`.
 *
 *   pnpm tsx experiments/morph-runtime-probe.ts [--state-dir ~/.morph] [--profile <llm profile>] [--keep]
 *
 * Writes every observation to `oar-trial-run/morph-probe-<ts>.json`.
 *
 * OBSERVED (2026-10-04, morph dev build, profile codex / gpt-5.6-luna):
 * - Submission answers 200 `{id, status: "queued", topic_id}`; a new topic is
 *   created when `topic_id` is omitted, and `workspace_dir` attaches it.
 * - `/stream/ws` frames are snapshots: accumulated `text` / `reasoning` and a
 *   bounded `trace.entries` window whose entries carry per-task `seq`. Agent
 *   events seen: turn_start, llm_start, llm_done, tool_start (activity_id =
 *   provider call id, args), tool_output (tool_name only, stream + text),
 *   tool_done (activity_id, text starting "exit_code: N"), steer_queued,
 *   steer_applied (the steer text), run_stop_requested, turn_canceled,
 *   run_stopped, turn_done, llm_retry ("Retrying in 1.0s (1/5).").
 * - `text` with `preview: true` is Console's tool status line, not model
 *   output; model text streams in non-preview snapshots ("sle" → "slept steered").
 * - The final `done` frame arrives with the terminal status, but the socket
 *   is not closed by the server.
 * - Terminal TaskInfo: `result.final.output`, `result.metrics.total_tokens`
 *   (no input/output split), `result.trace` repeating the window, `error`.
 * - Text sent to a running topic: 200 `{status: "done", steer_target_task_id}`,
 *   then steer_queued and, at the next step, steer_applied in the run's trace;
 *   the model honored it.
 * - Stop: `{status: "stopping", found: true}`, the task ends `canceled` with
 *   error "stopped by user" ~2 s later. Its last snapshots (status `failed`
 *   with `error`, then `canceled`) carry that error as `text`, and so can the
 *   task's `final.output`: not model output.
 * - `GET /topic/{id}/metadata` reports `context.used_input_tokens`,
 *   `context_window_tokens`, `usage_ratio` once a turn has run.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "undici";

type Json = Record<string, unknown>;
const asJson = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {});
const field = (value: unknown, key: string): string => {
  const found = asJson(value)[key];
  return typeof found === "string" ? found : "";
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const stateDir = flag("--state-dir") ?? join(homedir(), ".morph");
const keep = args.includes("--keep");
const profile = flag("--profile");
const published: unknown = JSON.parse(readFileSync(join(stateDir, "console", "runtime.json"), "utf8"));
const url = field(published, "url");
const auth = { Authorization: `Bearer ${field(published, "token")}` };
const log: unknown[] = [];
const note = (what: string, value: unknown): void => {
  log.push({ at: Date.now(), what, value });
  console.log(what, JSON.stringify(value).slice(0, 400));
};
const withProfile = (body: Json): Json => (profile === undefined ? body : { ...body, llm_profile: profile });

async function call(method: string, path: string, body?: Json): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const value: unknown = (response.headers.get("content-type") ?? "").includes("json") && text !== "" ? JSON.parse(text) : text;
  note(`${method} ${path} -> ${String(response.status)}`, value);
  return value;
}

function watch(taskId: string): { frames: unknown[]; close: () => void } {
  const frames: unknown[] = [];
  const socket = new WebSocket(`${url.replace(/^http/u, "ws")}/stream/ws?task_id=${taskId}`, { headers: auth });
  socket.addEventListener("message", (event) => {
    const frame: unknown = JSON.parse(String(event.data));
    frames.push({ at: Date.now(), frame });
  });
  return {
    frames,
    close: () => {
      socket.close();
    },
  };
}

async function settle(taskId: string, onRunning?: () => Promise<void>): Promise<unknown> {
  let fired = false;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by construction.
    const response = await fetch(`${url}/tasks/${taskId}`, { headers: auth });
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by construction.
    const info: unknown = await response.json();
    log.push({ at: Date.now(), what: `poll ${taskId}`, value: info });
    const status = field(info, "status");
    if (status === "running" && onRunning !== undefined && !fired) {
      fired = true;
      // oxlint-disable-next-line no-await-in-loop -- the probe acts once, mid-run.
      await onRunning();
    }
    if (["done", "failed", "canceled"].includes(status)) {
      note(`settled ${taskId}`, info);
      return info;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by construction.
    await delay(250);
  }
}

async function turn(name: string, body: Json, onRunning?: (taskId: string) => Promise<void>): Promise<unknown> {
  const submitted = await call("POST", "/tasks", withProfile(body));
  const taskId = field(submitted, "id");
  const tap = watch(taskId);
  await settle(taskId, onRunning === undefined ? undefined : async (): Promise<void> => {
    await onRunning(taskId);
  });
  await delay(500);
  tap.close();
  note(`ws frames ${name}`, tap.frames);
  return submitted;
}

const workspace = mkdtempSync(join(tmpdir(), "oar-morph-probe-"));
await call("GET", "/health");

// 1. A turn with one shell tool call, in a new topic attached to a scratch workspace.
const first = await turn("turn 1", {
  task: "Use your bash tool to run `echo oar-probe` exactly once, then reply with only the word done.",
  workspace_dir: workspace,
});
const topicId = field(first, "topic_id");

// 2. A follow-up in the same topic: does it continue the conversation?
await turn("turn 2", { task: "What word did the command print? Answer with that word only.", topic_id: topicId });

// 3. Steer: plain text into a topic whose task is running.
await turn("turn 3", { task: "Use bash to run `sleep 6 && echo slept`, then reply with what it printed.", topic_id: topicId }, async () => {
  await delay(1500);
  await call("POST", "/tasks", withProfile({ task: "Also append the word steered to your final reply.", topic_id: topicId }));
});

// 4. Stop a running task.
await turn("turn 4", { task: "Use bash to run `sleep 20`, then reply finished.", topic_id: topicId }, async (taskId) => {
  await delay(2000);
  await call("POST", `/tasks/${taskId}/stop`);
});

await call("GET", `/tasks?topic_id=${topicId}&limit=20`);
await call("GET", `/topic/${topicId}/metadata`);
if (!keep) {
  await call("DELETE", `/topics/${topicId}`);
}
mkdirSync("oar-trial-run", { recursive: true });
const out = join("oar-trial-run", `morph-probe-${String(Date.now())}.json`);
writeFileSync(out, JSON.stringify(log, null, 2));
console.log(`wrote ${out}`);
