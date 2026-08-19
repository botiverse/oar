# Detect architecture

Detect has two different jobs and therefore two different input contracts.

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

- `discovery/install/types.ts`: public states, evidence, and target contract;
- `discovery/install/attempts.ts`: generic candidate execution;
- `discovery/install/policies.ts`: compatibility policy such as Grok stdio and
  OpenCode minimum version;
- `discovery/install/service.ts`: one-row and registered sweeps.

Host-specific candidates live under `discovery/host/`. Special Claude/Codex
resolution is isolated in `host/installAttempts.ts`; the production identity
registry is `host/installTargets.ts`.

`RuntimeDriver` does not carry install candidates. `createHostDrivers()` owns
catalog/drive assembly; `createHostInstallTargets()` owns install assembly. The
parity test requires both registries to contain the same runtime identities.

## Dependency direction

The generic catalog/install services may depend on contracts and generic
utilities. They must not import runtime drivers or host resolvers. Host
implementations depend inward on those contracts. Public compatibility files
(`detect.ts`, `installDetect.ts`) are facades only.
