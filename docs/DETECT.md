# Detect architecture

Detect has two different jobs and therefore two narrow internal contracts. A
consumer still adopts one complete `RuntimeDefinition`; the catalog and install
views are projections of the same canonical registry.

## Catalog detection

`CatalogTarget` answers “is this runtime present, and which models/providers can
it offer?” It is implemented by `discovery/catalog/*` and consumed through the
stable `discovery/detect.ts` facade.

The target deliberately contains no session/process members. A full
`RuntimeDriver` satisfies the narrow interface structurally, but the catalog
service cannot depend on drive implementation details.

## Install detection

`InstallTarget` answers “can the host start this runtime contract?” It is
implemented in four layers:

- `discovery/install/contract.ts`: states, evidence, and target contract;
- `discovery/install/attempts.ts`: generic candidate execution;
- `discovery/install/policies.ts`: compatibility policy such as Grok stdio and
  OpenCode minimum version;
- `discovery/install/detectInstall.ts`: one-row and registered sweeps.

Host-specific candidates live under `discovery/host/`. Claude, Codex, and Kimi
CLI install candidates each have a named `*Install.ts` module; shared resolver
adaptation lives in `host/installProbeHelpers.ts`. The production identity
registry is `runtime/registry.ts`.

Each runtime definition has its own file under `runtime/definitions/`. Small
group modules keep the final registry below the dependency-hub threshold while
preserving the deliberate presentation order. Adding a runtime therefore has
one obvious composition file and cannot require editing separate catalog and
install identity lists.

`RuntimeDriver` does not carry install candidates. `runtime/registry.ts` owns one
`RuntimeDefinition[]`; `createHostDrivers()` and `createHostInstallTargets()`
are derived views. Runtime identity therefore has one source rather than two
hand-maintained registries guarded by an order-sensitive parity assertion.

## Dependency direction

The generic catalog/install services may depend on contracts and generic
utilities. They must not import runtime drivers or host resolvers. Host
implementations depend inward on those contracts. Public compatibility files
(`detect.ts`, `installDetect.ts`) are facades only.
