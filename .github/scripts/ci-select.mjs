// Picks which behavior backends and platforms a CI run needs, from the files it
// changes. Pull requests run affected backends on Linux plus Windows OpenCode v2.
// Main pushes and dispatches run all Linux backends plus the non-Linux jobs
// proven to catch platform-only failures in the 50-run audit; the remaining
// macOS and Windows behavior/ACP matrices run daily in platform-matrix.yml.
// The release gate waits only for ci.yml on the exact release commit.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const behavior = ["claude-aimock", "codex-aimock", "pi-aimock", "pi-rpc-aimock", "pi-durable-aimock", "qwen-aimock", "qoder-native", "dsh-aimock", "factory-aimock", "bottega-aimock"];
const acp = ["kimi-aimock", "grok-aimock", "opencode-aimock", "codebuddy-aimock"];
const acpInstallations = [
  ...acp.map(backend => ({ backend })),
  { backend: "opencode-v2-aimock", suite: "opencode-aimock", pin: "opencode-cleanup" },
];
const all = [...behavior, ...acp];

// Non-Linux behavior jobs kept on main pushes/dispatches (50-run audit evidence):
// - windows-latest dsh-aimock: 19/50 unique failures (e.g. run 44784700637 / job 136456409926)
// - windows-latest codex-aimock: 9/50 unique failures (e.g. run 44731287320 / job 136271471468)
// All macOS jobs (including claude-aimock, whose sole unique failure was test bug #1067)
// run daily in platform-matrix.yml so pushes and releases never wait on the macOS queue.
const pushNonLinuxBehavior = [
  { os: "windows-latest", backend: "codex-aimock" },
  { os: "windows-latest", backend: "dsh-aimock" },
];

// Daily/on-demand sharded macOS and Windows matrices (platform-matrix.yml).
// Kept here alongside ci.yml selection so every verified platform has one source of truth.
export const dailyShards = {
  "macos-behavior-1": {
    os: "macos-latest",
    entries: [
      { kind: "behavior", backend: "dsh-aimock", install: true },
      { kind: "behavior", backend: "qoder-native", install: true },
      { kind: "behavior", backend: "claude-aimock", install: true },
      { kind: "behavior", backend: "pi-aimock", install: false },
      { kind: "behavior", backend: "pi-durable-aimock", install: false },
    ],
  },
  "macos-behavior-2": {
    os: "macos-latest",
    entries: [
      { kind: "behavior", backend: "codex-aimock", install: true },
      { kind: "behavior", backend: "pi-rpc-aimock", install: false },
      { kind: "behavior", backend: "qwen-aimock", install: true },
      { kind: "behavior", backend: "factory-aimock", install: true },
    ],
  },
  "macos-acp": {
    os: "macos-latest",
    entries: [
      { kind: "acp", backend: "kimi-aimock", install: true },
      { kind: "acp", backend: "grok-aimock", install: true },
      { kind: "acp", backend: "opencode-aimock", install: true },
      { kind: "acp", backend: "opencode-v2-aimock", suite: "opencode-aimock", pin: "opencode-cleanup", install: true },
      { kind: "acp", backend: "codebuddy-aimock", install: true },
    ],
  },
  "windows-behavior-1": {
    os: "windows-latest",
    entries: [
      { kind: "behavior", backend: "qoder-native", install: true },
      { kind: "acp", backend: "opencode-v2-aimock", suite: "opencode-aimock", pin: "opencode-cleanup", install: true },
      { kind: "behavior", backend: "pi-aimock", install: false },
      { kind: "behavior", backend: "pi-durable-aimock", install: false },
    ],
  },
  "windows-behavior-2": {
    os: "windows-latest",
    entries: [
      { kind: "behavior", backend: "claude-aimock", install: true },
      { kind: "behavior", backend: "qwen-aimock", install: true },
      { kind: "acp", backend: "opencode-aimock", install: true },
      { kind: "pi-rpc-windows-behavior", backend: "pi-rpc-aimock", install: false },
    ],
  },
};

/** A runtime's own code reaches only its own backends. Runtimes without a behavior backend reach none. */
const backendsOf = {
  claude: ["claude-aimock"], codex: ["codex-aimock"], pi: ["pi-aimock", "pi-rpc-aimock", "pi-durable-aimock"], // pi-durable imports pi
  "pi-durable": ["pi-durable-aimock"], qwen: ["qwen-aimock"], qoder: ["qoder-native"],
  dsh: ["dsh-aimock"], factory: ["factory-aimock"], kimi: ["kimi-aimock"], grok: ["grok-aimock"],
  opencode: ["opencode-aimock"], codebuddy: ["codebuddy-aimock"], antigravity: [], devin: [], cursor: [], bottega: ["bottega-aimock"],
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

/** Union of all push (ci.yml) and daily (platform-matrix.yml) ACP jobs for platform verification checks. */
export function verifiedAcpJobs() {
  const pushAcp = selectCiJobs({ pullRequest: false, files: null }).acp;
  const dailyAcp = Object.values(dailyShards).flatMap(shard => shard.entries
    .filter(entry => entry.kind === "acp")
    .map(entry => ({ os: shard.os, backend: entry.backend, ...(entry.suite ? { suite: entry.suite } : {}), ...(entry.pin ? { pin: entry.pin } : {}) })));
  return [...pushAcp, ...dailyAcp];
}

export function selectCiJobs({ pullRequest, files }) {
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
  const selectedBehavior = behavior.filter((backend) => selected.includes(backend));
  const behaviorJobs = [
    ...selectedBehavior.map((backend) => ({ os: "ubuntu-latest", backend })),
    ...(pullRequest ? [] : pushNonLinuxBehavior.filter((job) => selectedBehavior.includes(job.backend))),
  ];
  // Linux runs every selected ACP pin. Windows OpenCode v2 runs on PRs touching
  // OpenCode and in daily platform-matrix.yml; it is parked off main push and
  // release until the known readiness flake (#core:#360) is fixed.
  const acpJobs = [
    ...acpInstallations
      .filter((installation) => selected.includes(installation.suite ?? installation.backend))
      .map((installation) => ({ os: "ubuntu-latest", ...installation })),
    ...(pullRequest ? acpInstallations
      .filter((installation) => installation.backend === "opencode-v2-aimock" && selected.includes(installation.suite ?? installation.backend))
      .map((installation) => ({ os: "windows-latest", ...installation })) : []),
  ];
  return {
    behavior: behaviorJobs,
    acp: acpJobs,
    pi_rpc: selected.includes("pi-rpc-aimock"),
    // Windows Pi RPC vendor phase runs on main pushes/dispatches (1/50 unique failure: 44728473944/136261891688).
    pi_rpc_windows: !pullRequest && selected.includes("pi-rpc-aimock"),
  };
}

function changedFiles() {
  const base = process.env.BASE_SHA;
  if (base === undefined || base === "") { return null; }
  return execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "reach") {
  // Test entry point: print the backends one path reaches (null = every backend).
  process.stdout.write(`${JSON.stringify(reach(process.argv[3] ?? ""))}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "verified-acp") {
  process.stdout.write(`${JSON.stringify(verifiedAcpJobs())}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "shards") {
  process.stdout.write(`${JSON.stringify(dailyShards)}\n`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";
  const files = pullRequest ? changedFiles() : null;
  const picked = selectCiJobs({ pullRequest, files });
  const out = {
    behavior: JSON.stringify(picked.behavior),
    acp: JSON.stringify(picked.acp),
    pi_rpc: String(picked.pi_rpc),
    pi_rpc_windows: String(picked.pi_rpc_windows),
  };
  for (const [key, value] of Object.entries(out)) {
    process.stdout.write(`${key}=${value}\n`);
    if (process.env.GITHUB_OUTPUT !== undefined) { appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); }
  }
}
