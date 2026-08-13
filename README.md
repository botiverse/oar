# oar

**An agent client access layer** (`@botiverse/oar`).

Host-side access to agent runtimes: detect what is installed, read account usage,
and (where wired) start a session and consume typed events. The intended first consumer / integration target is [Raft](https://github.com/botiverse). That
integration is not landed in this 0.0.1 (no Raft adapter PR yet). Raft
experience is a seed corpus, not the spec — where product shape and the general
contract diverge, the contract wins.

> **0.0.1 status (this npm package).** Detect + account-usage are the supported
> library/CLI surfaces. `oar run` has a **full turn** path only for **Codex**
> (app-server handshake → prompt → events). Other runtimes may start or
> catalog; they do **not** complete a turn (Pi `prompt()` throws
> `turn/prompt API not wired`). This is not “sea-trial green for every
> driver”, and it is not “nothing works”. Do not treat an empty
> `sea-trial/cases/` as a pass.

An *agent client* is the host: it starts a runtime, drives it, and observes
events. `oar` is that access layer.

## Install

`@botiverse/oar` is **ESM-only** and requires **Node >= 20**. Use static
`import` from the package. CommonJS `require` of this package is unsupported
(it resolves to the ESM entry). If you must stay in CJS, use dynamic `import()`.

```bash
npm install @botiverse/oar
```

Optional peers are **host-provided SDK integrations** (not required to
install oar). They are used as follows:

- `@botiverse/kimi-code-sdk` — detect/version for canonical `kimi`
- `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent` —
  detect/version **and** `providers()` / `start()` for `pi` (catalog +
  session create). `start()` does **not** mean a wired turn.

```bash
npx oar --help
npx oar --version
npx oar detect
npx oar usage
```

After a local install the same binary is `./node_modules/.bin/oar`.

In this repo, development still uses **pnpm**: `pnpm oar detect`.

## Library

```js
import {
  detectAll,
  createHostDrivers,
  collectUsage,
} from "@botiverse/oar";

const board = await detectAll(createHostDrivers());
const grokUsage = await collectUsage("grok", {
  collectorVersion: "my-host-1.0.0",
  localAccountSlot: "local",
  observedAtMs: Date.now(),
});
```

`detectAll(drivers)` **omits** runtimes whose `detect()` returned null
(not installed). It does **not** emit a full four-state board.
`detectAllRegistered(drivers, registryIds)` emits one row per registry id
and is the API that keeps `not_installed`. The other three failures
(`needs_login` / `models_unavailable` / `detect_failed`) can appear on
either API when the driver is present. `collectUsage` is separate from
detect so “no usage surface” cannot look like “0% used”. Host adapters
must pass `collectorVersion` and should pass a single `observedAtMs` for a
sweep; standalone CLI defaults to `oar-0.0.0`.

## Host runtimes

| id | What detect means | New-agent form |
| --- | --- | --- |
| `claude` | Claude Code CLI | yes |
| `codex` | Codex CLI / app-server | yes |
| `grok` | Grok CLI | yes |
| `antigravity` | `agy` CLI | yes |
| `copilot` | Copilot CLI presence | yes |
| `cursor` | `cursor-agent` presence | yes |
| `gemini` | Gemini CLI | **deprecated** (compat only) |
| `kimi` | **Kimi Code SDK only** — absent if the SDK package is not resolvable | yes |
| `kimi-cli` | **legacy Kimi CLI** — binary presence/version only (`0.0.1` P2 composite) | **deprecated** (compat only) |
| `opencode` | OpenCode CLI | yes |
| `pi` | Pi coding-agent SDK only | yes |

Identity that must not alias: SDK-only ⇒ `kimi` present, `kimi-cli` absent;
CLI-only ⇒ `kimi` `not_installed`, `kimi-cli` present. Raft maps
`kimi → kimi-sdk`, `kimi-cli → kimi`, and synthesizes `builtin` from OAR `pi`.

Four detect failures stay distinct: `not_installed` / `needs_login` /
`models_unavailable` / `detect_failed`.

### `oar usage`

| provider | Surface |
| --- | --- |
| `codex` | app-server `account/rateLimits/read` |
| `kimi` | `GET {platform}/usages` |
| `claude` | `claude -p /usage --output-format json` (text parse) |
| `grok` | `unsupported` — no programmable usage API in current binary |

## The three parts

| Part | What it is | 0.0.1 honesty |
| --- | --- | --- |
| **RRP** | Host↔runtime contract, chapter by chapter. Map: [docs/rrp-chapters.md](docs/rrp-chapters.md). | Written in parts; not a finished freeze. |
| **drydock** | Drive a runtime **with no host daemon**. | Required invariant. Implementation is partial. |
| **sea-trial** | Same conformance suite for every runtime. [docs/behavior-tests.md](docs/behavior-tests.md). | **Not** green across drivers. Not a publish gate for 0.0.1. |

**drydock must work without a host daemon.** That claim cannot be
self-certified. It is the design constraint, not a statement that every runtime
already passes.

## Open risks (not silently closed)

- **Vendor terms.** Whether shipping adapters that wrap commercial vendor CLIs
  creates redistribution / ToS obligations is **unchecked**. Owner: **@xxchan**.
  This is an explicit first-publish risk, not a deleted warning. It is **not**
  silently treated as “blocks npm 0.0.1” unless xxchan says it is a live hold.
- **Maintenance ownership.** Vendor CLIs churn. A named long-term owner is
  still needed; 0.0.1 does not invent one.
- **Whether `RRP` stays a separate name.** Leaning keep: the chapter map is
  larger than the npm CLI.

## Licence

[Apache-2.0](LICENSE).
