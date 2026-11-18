import { parseArgs } from "node:util";
import type { AgentStatusLine } from "./support.js";
import { call, detach, up } from "./daemon.js";
import { formatEntry, printStatus, read, trace, watch } from "./inspect.js";
import { runDir, Store } from "./store.js";

const USAGE = `harbor: a small Raft-like channel for long OAR runs with real agents

  harbor up --agent <name=runtime[:model]> ... [--agent-env name:KEY=VALUE ...]
            [--stall-min 10] [--for HOURS] [--max-disk-gb N] [--detach]
  harbor add <name=runtime[:model]>        add an agent to the running daemon
  harbor send [text]                        post (stdin when no text); @name routes, @all reaches everyone
  harbor read [--after N] [--limit 20]      channel messages
  harbor status                             each agent: state, turn time, context, tokens, pending
  harbor watch [--all]                      follow findings (every journal entry with --all)
  harbor findings [agent]                   findings so far
  harbor trace <agent> [--turn N | --around SEQ] [--session N] [--raw]
  harbor trace --voyage <path from a finding> --around SEQ
  harbor restart <agent> [--fresh]          dispose and reopen (resuming unless --fresh)
  harbor down                               dispose every agent and stop

  --dir <path> (or HARBOR_DIR) selects the run; default ~/.oar-harbor/default.
  A message from someone who is not an agent and names no one goes to every agent.`;

const OPTIONS = {
  dir: { type: "string" },
  agent: { type: "string", multiple: true },
  "stall-min": { type: "string" },
  "agent-env": { type: "string", multiple: true },
  for: { type: "string" },
  "max-disk-gb": { type: "string" },
  detach: { type: "boolean" },
  from: { type: "string" },
  after: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
  turn: { type: "string" },
  around: { type: "string" },
  session: { type: "string" },
  voyage: { type: "string" },
  raw: { type: "boolean" },
  fresh: { type: "boolean" },
} as const;

async function main(argv: readonly string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  const dir = runDir(values.dir);
  if (command === "up") {
    if (values.detach === true) {
      detach(dir, rest);
      return;
    }
    await up(dir, values.agent ?? [], {
      stallMs: Number(values["stall-min"] ?? "10") * 60_000,
      agentEnv: values["agent-env"] ?? [],
      ...(values.for === undefined ? {} : { forMs: Number(values.for) * 3_600_000 }),
      ...(values["max-disk-gb"] === undefined ? {} : { maxBytes: Number(values["max-disk-gb"]) * 1024 ** 3 }),
    });
  } else if (command === "add") {
    console.log(JSON.stringify(await call(dir, "/add", { spec: positionals[0] })));
  } else if (command === "send") {
    const text = positionals.length > 0 ? positionals.join(" ") : await stdin();
    const from = values.from ?? process.env.HARBOR_AGENT ?? "qa";
    const sent = await call(dir, "/send", { from, text });
    const to = Array.isArray(sent.to) ? sent.to.map(String) : [];
    console.log(`sent msg=${String(sent.seq)} to ${to.length === 0 ? "nobody" : to.map((name) => `@${name}`).join(" ")}`);
  } else if (command === "read") {
    read(new Store(dir), Number(values.after ?? "0"), Number(values.limit ?? "20"));
  } else if (command === "status") {
    const reply = await call(dir, "/status");
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- the daemon's /status route returns exactly these lines.
    printStatus((Array.isArray(reply.agents) ? reply.agents : []) as AgentStatusLine[]);
  } else if (command === "watch") {
    await watch(new Store(dir), values.all === true);
  } else if (command === "findings") {
    for (const entry of new Store(dir).entries()) {
      if (entry.kind === "finding" && (positionals[0] === undefined || entry.agent === positionals[0])) {
        console.log(formatEntry(entry));
      }
    }
  } else if (command === "trace") {
    trace(new Store(dir), positionals[0] ?? "", {
      ...(values.turn === undefined ? {} : { turn: Number(values.turn) }),
      ...(values.around === undefined ? {} : { around: Number(values.around) }),
      ...(values.session === undefined ? {} : { session: Number(values.session) }),
      ...(values.voyage === undefined ? {} : { voyage: values.voyage }),
      raw: values.raw === true,
    });
  } else if (command === "restart") {
    console.log(JSON.stringify(await call(dir, "/restart", { agent: positionals[0], fresh: values.fresh === true })));
  } else if (command === "down") {
    console.log(JSON.stringify(await call(dir, "/down", {})));
  } else {
    console.log(USAGE);
    process.exitCode = command === "help" || command === "--help" ? 0 : 2;
  }
}

async function stdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text.trim();
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`harbor: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
