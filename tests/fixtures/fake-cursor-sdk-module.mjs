/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/explicit-function-return-type, eslint/max-classes-per-file -- Standalone untyped module a cursor child imports. */
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/*
 * A stand-in for the part of `@cursor/sdk` 1.3.1 OAR uses, as a module: a
 * cursor child imports it through `sdkModule` (subprocess mode), and a test
 * can hand it over in process too (`sdk: () => import(...)`). Each run does
 * what its prompt says:
 * - `echo:<text>`: a text delta, a stream message, a turn-ended delta with
 *   usage, then `finished` with `result: <text>`.
 * - `shell:<command>`: runs the command through a shell (`execSync`) with
 *   this process's environment, as the SDK's shell tool does, and finishes
 *   with its trimmed stdout as `result`.
 * - `hold`: runs until cancelled.
 * - `crash-on-cancel`: runs until cancelled, and the cancel SIGKILLs this
 *   process.
 * - `crash`: a text delta, then this process SIGKILLs itself.
 * - `throw`: a text delta, then an uncaught exception ends this process.
 * - `spawn:<file>`: starts a grandchild (a Node process sleeping for 60 s)
 *   detached, so it leads a process group of its own, as SDK 1.3.1 starts
 *   its shell tool on POSIX (`detached: !win32`, bundle `dist/esm/305.js`),
 *   writes `{"child", "grandchild"}` pids to <file>, and finishes.
 * - `spawn-in-group:<file>`: the same, with the grandchild in this
 *   process's group.
 * - `background:<file>`: runs `/bin/sh -c "sleep 300 & ..."` detached, as
 *   the SDK runs a tool command, which writes the background sleep's pid to
 *   <file> and exits; the run finishes once that shell exited. The sleep is
 *   then reparented away from this process, outside its group.
 * - `background-unmarked:<file>`: the same, with the shell started without
 *   the `OAR_CURSOR_CHILD_<id>` marker OAR put in this process's environment.
 * A steer is taken (`complete_delivered`) and echoed as a delta. With
 * `CURSOR_API_KEY=rejected-key-0123456789` the open and the model listing
 * fail the way the SDK refuses a key (`AuthenticationError`, status 401).
 * `Cursor.auth` keeps its login in `$OAR_FAKE_CURSOR_HOME/auth.json`;
 * `OAR_FAKE_CURSOR_LOGIN=hold` makes a login wait for its signal. Like SDK
 * 1.3.1, `close()` only starts the agent's close work and
 * `Symbol.asyncDispose` waits for it: 300 ms, after which it writes
 * `$OAR_FAKE_CURSOR_CLOSED` (a file path), when set.
 */

/** The minted key the fake login saves: never in IPC, a record or a result. */
export const FAKE_KEY = "crsr_fake_child_minted_key_0123456789abcdef";
export const FAKE_LOGIN_URL = "https://cursor.com/loginDeepControl?challenge=fake&mode=login&redirectTarget=sdk";
const REJECTED_KEY = "rejected-key-0123456789";

function refused() {
  return Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401 });
}

class FakeRun {
  done = Promise.withResolvers();
  messages = [];
  wake = Promise.withResolvers();
  closed = false;

  constructor(id, onDelta) {
    this.id = id;
    this.onDelta = onDelta;
  }

  delta(update) { this.onDelta({ update }); }

  message(value) {
    this.messages.push(value);
    this.wake.resolve();
  }

  end(status, result) {
    this.done.resolve({ id: this.id, status, model: { id: "composer-2.5" }, ...(result === undefined ? {} : { result }) });
    this.closed = true;
    this.wake.resolve();
  }

  async wait() { return this.done.promise; }

  async *stream() {
    for (;;) {
      while (this.messages.length > 0) { yield this.messages.shift(); }
      if (this.closed) { return; }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the next message is not there until the run adds it.
      await this.wake.promise;
      this.wake = Promise.withResolvers();
    }
  }

  async cancel() {
    if (this.crashOnCancel === true) { process.kill(process.pid, "SIGKILL"); }
    this.end("cancelled");
  }

  async steer(text) {
    this.delta({ type: "user-message-appended", userMessage: { type: "user_message", text } });
    return "complete_delivered";
  }
}

function echo(run, said) {
  run.delta({ type: "text-delta", text: said });
  run.message({ type: "assistant", run_id: run.id, message: { content: [{ type: "text", text: said }] } });
  run.delta({ type: "turn-ended", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 } });
  run.end("finished", said);
}

function crash(run) {
  run.delta({ type: "text-delta", text: "about to crash" });
  setTimeout(() => { process.kill(process.pid, "SIGKILL"); }, 20);
}

function startTool(run, file, detached = true) {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached });
  grandchild.once("spawn", () => {
    writeFileSync(`${file}.tmp`, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    renameSync(`${file}.tmp`, file);
    run.end("finished");
  });
}

function background(run, file, unmarked = false) {
  const env = unmarked ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OAR_CURSOR_CHILD_"))) : process.env;
  const shell = spawn("/bin/sh", ["-c", `sleep 300 & echo $! > "${file}.tmp" && mv "${file}.tmp" "${file}"`], { stdio: "ignore", detached: true, env });
  shell.once("exit", () => { run.end("finished"); });
}

const behaviors = {
  echo,
  shell: (run, command) => { run.end("finished", execSync(command, { encoding: "utf8" }).trim()); },
  crash,
  throw: (run) => {
    run.delta({ type: "text-delta", text: "about to throw" });
    setTimeout(() => { throw new Error("fake SDK failure"); }, 20);
  },
  spawn: startTool,
  "spawn-in-group": (run, file) => { startTool(run, file, false); },
  background,
  "background-unmarked": (run, file) => { background(run, file, true); },
  hold: () => {},
  "crash-on-cancel": (run) => { run.crashOnCancel = true; },
};

function act(run, text) {
  const colon = text.indexOf(":");
  const [name, argument] = colon === -1 ? [text, ""] : [text.slice(0, colon), text.slice(colon + 1)];
  const behavior = behaviors[name];
  if (behavior === undefined) { run.end("error"); } else { behavior(run, argument); }
}

class FakeAgent {
  #runs = 0;
  closed = false;

  constructor(agentId, model) {
    this.agentId = agentId;
    this.model = model;
  }

  async send(message, options) {
    this.#runs += 1;
    const run = new FakeRun(`run-${String(this.#runs)}`, options.onDelta);
    const text = typeof message === "string" ? message : message.text;
    setImmediate(() => { act(run, text); });
    return run;
  }

  async summarize() {
    return this.send("echo:summary", { onDelta: () => {} });
  }

  close() {
    this.closing ??= (async () => {
      await delay(300);
      this.closed = true;
      if (process.env.OAR_FAKE_CURSOR_CLOSED !== undefined) { writeFileSync(process.env.OAR_FAKE_CURSOR_CLOSED, this.agentId); }
    })();
  }

  async [Symbol.asyncDispose]() {
    this.close();
    await this.closing;
  }
}

async function opened(agentId, options) {
  await Promise.resolve();
  if (process.env.CURSOR_API_KEY === REJECTED_KEY) { throw refused(); }
  return new FakeAgent(agentId, options.model);
}

export const Agent = {
  create: async (options) => opened("agent-1", options),
  resume: async (agentId, options) => opened(agentId, options),
  listRuns: async () => ({ items: [{ model: { id: "composer-2.5" }, createdAt: 1 }] }),
};

const authFile = () => path.join(process.env.OAR_FAKE_CURSOR_HOME ?? "/nonexistent", "auth.json");

export class FileCredentialStore {
  async save(credentials) {
    await Promise.resolve();
    writeFileSync(authFile(), JSON.stringify(credentials));
  }
}

export const Cursor = {
  models: {
    async list() {
      await Promise.resolve();
      if (process.env.CURSOR_API_KEY === REJECTED_KEY) { throw refused(); }
      return [{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }] }];
    },
  },
  auth: {
    async status() {
      await Promise.resolve();
      if (!existsSync(authFile())) { return { status: "logged-out" }; }
      const { email } = JSON.parse(readFileSync(authFile(), "utf8"));
      return { status: "logged-in", email };
    },
    async login({ onLoginUrl, signal, store }) {
      onLoginUrl(FAKE_LOGIN_URL);
      if (process.env.OAR_FAKE_CURSOR_LOGIN === "hold") {
        await once(signal, "abort");
        throw new Error("Login was cancelled.");
      }
      const credentials = { apiKey: FAKE_KEY, email: "child@example.com", apiKeyExpiresAtMs: Date.UTC(2027, 0, 4) };
      await store.save(credentials);
      // The SDK resolves with what it saved, the key among it.
      return credentials;
    },
    async logout() {
      await Promise.resolve();
      rmSync(authFile(), { force: true });
    },
  },
};
