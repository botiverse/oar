# Cursor subprocess mode: host memory with one session open

Run on 2026-11-11 with [`measure.ts`](measure.ts): Linux arm64 (aarch64),
Node 24.18.1, the real `@cursor/sdk` 1.3.1 this workspace installs (the
version `packages/cli` depends on), no `CURSOR_API_KEY`, `HOME` a fresh
temporary directory. Each line is a fresh Node process started with
`--expose-gc` and `--import tsx`; memory is read after a forced GC, before
the session opens and one second after it opened. No run was sent: opening
a session (`Agent.create`) succeeds without a key, a run would not.

| mode | host RSS before | host RSS open | host heap before | host heap open | direct children RSS | open took |
|---|---|---|---|---|---|---|
| in process | 234 MB | 449 MB | 81 MB | 129 MB | 15 MB | 814 ms |
| subprocess | 227 MB | 227 MB | 81 MB | 80 MB | 126 MB | 444 ms |
| in process | 235 MB | 441 MB | 81 MB | 129 MB | 3 MB | 729 ms |
| subprocess | 223 MB | 224 MB | 81 MB | 80 MB | 121 MB | 417 ms |

Reading it:

- In process, opening one session grew the host by 206 to 215 MB RSS and
  48 MB V8 heap: the SDK bundle loaded, plus the agent. In subprocess mode
  the host grew by at most 1 MB RSS and not at all in heap; the SDK lives in
  the child.
- "Direct children RSS" sums `ps -o rss= --ppid <host>`, which includes the
  `ps` process itself (about 3 MB). In subprocess mode it is mostly the
  session's child: about 118 to 123 MB. Where the 15 MB in the first
  in-process line came from (a short-lived process the SDK started, or
  `ps`) was not looked into.
- The "before" baseline (about 225 to 235 MB) is mostly tsx and OAR's own
  modules; it is the same in both modes.
- The open time includes loading the SDK in both modes (in process the
  host's first session loads it, through tsx's loader; in subprocess mode
  the child imports it with plain Node). Why the subprocess open was faster
  was not investigated; two samples per mode are not a timing benchmark.

`envBase: "clean"` with the real SDK: a session opened with `env` holding
only `HOME` (a temporary directory), and with `HOME` and `PATH`. A first run
of this script also opened one with an empty `env`; without `HOME`, Node's
`os.homedir()` fell back to the user's passwd entry and the SDK created its
agent store under the real `~/.cursor/projects/`, which was then removed by
hand. The script no longer opens that case. Whether a run (tools, ripgrep,
MCP servers, a key from the environment) works under `clean` with these
minimal environments was not measured.

A rerun the same day, after the child started awaiting the agent's
`Symbol.asyncDispose` on close and ending its descendant tree: in process
the host grew by 174 and 195 MB RSS and 48 MB heap; in subprocess mode by
0 MB, with 121 MB in direct children both times. The spread between the
in-process runs (174 to 215 MB) is run to run variation that was not
looked into. Disposing such a real-SDK session (`inherit`, and `clean` with
`HOME` and `PATH`) took 118 and 173 ms and was answered `exited`, code 0.

Not measured: macOS, Windows, a run, more than one session, memory over a
long session, and an Electron host.
