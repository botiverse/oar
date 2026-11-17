// Picks which behavior backends and platforms a CI run needs, from the files it
// changes. Pushes to main, dispatches and anything this script cannot place run
// everything; a pull request runs only the backends its change can reach, on
// Linux. macOS and Windows behavior run after merge, and the release gate waits
// for main's run on the exact commit (.github/workflows/release.yml).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const behavior = ["claude-aimock", "codex-aimock", "pi-aimock", "pi-rpc-aimock", "pi-durable-aimock", "qwen-aimock", "qoder-native", "dsh-aimock", "factory-aimock"];
const acp = ["kimi-aimock", "grok-aimock", "opencode-aimock", "codebuddy-aimock"];
const all = [...behavior, ...acp];

/** A runtime's own code reaches only its own backends. Runtimes without a behavior backend reach none. */
const backendsOf = {
  claude: ["claude-aimock"], codex: ["codex-aimock"], pi: ["pi-aimock", "pi-rpc-aimock", "pi-durable-aimock"], // pi-durable imports pi
  "pi-durable": ["pi-durable-aimock"], qwen: ["qwen-aimock"], qoder: ["qoder-native"],
  dsh: ["dsh-aimock"], factory: ["factory-aimock"], kimi: ["kimi-aimock"], grok: ["grok-aimock"],
  opencode: ["opencode-aimock"], codebuddy: ["codebuddy-aimock"], antigravity: [], devin: [], cursor: [],
};
const runtimes = Object.keys(backendsOf).sort((a, b) => b.length - a.length);

/** Paths that cannot change behavior: the `check` job still covers them. */
// experiments/ is not inert: vendor tests and the behavior harness import its probes.
const inert = [/^docs\//u, /\.md$/u, /^assets\//u, /^apps\//u, /^packages\/cli\//u, /^packages\/oar\/assets\//u, /^tests\/(?!fixtures\/)/u, /^\.stamp\//u]; // tests/fixtures feeds vendor tests

/** The backends one changed file can reach; `null` means it may reach any of them. */
export function reach(file) {
  if (inert.some((pattern) => pattern.test(file))) { return []; }
  const runtime = /^packages\/oar\/src\/runtimes\/([^/]+)\//u.exec(file)?.[1];
  if (runtime !== undefined) { return backendsOf[runtime] ?? null; }
  // Runtimes importing shared/acp (antigravity, devin have no behavior backend).
  if (file.startsWith("packages/oar/src/shared/acp/")) { return [...acp, "qwen-aimock"]; }
  const vendor = /^sea-trial\/vendor\/(?:support\/)?([^/]+)$/u.exec(file)?.[1];
  if (vendor !== undefined) {
    const owner = runtimes.find((id) => vendor.startsWith(`${id}-`) || vendor.startsWith(`${id}.`));
    return owner === undefined ? null : backendsOf[owner];
  }
  return null;
}

import { pathToFileURL } from "node:url";

function changedFiles() {
  const base = process.env.BASE_SHA;
  if (base === undefined || base === "") { return null; }
  return execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "reach") {
  // Test entry point: print the backends one path reaches (null = every backend).
  process.stdout.write(`${JSON.stringify(reach(process.argv[3] ?? ""))}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";
  const files = pullRequest ? changedFiles() : null;
  let selected = all;
  if (files !== null) {
    const picked = new Set();
    for (const file of files) {
      const reached = reach(file);
      if (reached === null) { selected = all; break; }
      for (const backend of reached) { picked.add(backend); }
      selected = all.filter((backend) => picked.has(backend));
    }
  }
  const os = pullRequest ? ["ubuntu-latest"] : ["ubuntu-latest", "windows-latest", "macos-latest"];
  const out = {
    behavior: JSON.stringify(behavior.filter((backend) => selected.includes(backend))),
    acp: JSON.stringify(acp.filter((backend) => selected.includes(backend))),
    os: JSON.stringify(os),
    acp_os: JSON.stringify(os.filter((name) => name !== "windows-latest")),
    pi_rpc: String(selected.includes("pi-rpc-aimock")),
    // The Windows-only Pi RPC job runs after merge, like the other non-Linux jobs.
    pi_rpc_windows: String(!pullRequest && selected.includes("pi-rpc-aimock")),
  };
  for (const [key, value] of Object.entries(out)) {
    process.stdout.write(`${key}=${value}\n`);
    if (process.env.GITHUB_OUTPUT !== undefined) { appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); }
  }
}
