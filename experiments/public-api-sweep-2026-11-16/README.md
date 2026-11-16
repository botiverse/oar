# Public API export cleanup (2026-11-16)

Remove 109 unused or explicitly retired export names while preserving the
Runtime and Session contracts that hosts use. This is a breaking import change:
implementations remain internal, with their regression tests. No runtime
behavior, record format or retained type shape changes.

## Evidence and limits

The initial usage survey covered Raft, Ferry, rowrow, oar-coxswain, the OAR CLI
and nine public dependents. It suggested seven groups of high-confidence
removals, with a separate list needing host confirmation. This change includes
those seven groups and the subsequently confirmed model projection, Claude
account reader and form mapping helpers. Other candidates from that separate
list stay public.

The fresh audit checked actual imports, type imports, dynamic imports and
namespace accesses, not just identifier matches:

| Host | Revision | Result |
| --- | --- | --- |
| Raft | `1d689caf34442247cab70580d7feac1b8c302d60` | 197 named imports, including 168 type imports. Six approved test dependencies need migration; no new production dependency on removed exports. |
| Ferry | `117037bad0f9e6e51a5dc80adc66c3a7ed7b51c1` | All 272 named imports, including 194 type imports, remain. Both dynamic imports remain supported. |
| Airwing | Maintainer-provided import list, 2026-11-16 | All supplied values, types and member shapes remain; source was not available for a full audit. |

The six Raft test dependencies are `projectClaudeModels`,
`projectAntigravityModels`, `projectOpencodeModels`, `claudeAccountUsage`,
`toModelListing` and `validateConfig`. Raft agreed to migrate those tests before
updating its OAR dependency. A comment mentioning `projectAntigravityModels`,
a local `modelOf` helper and the `events` option `coalesceText` are not imports
of the removed functions.

The earlier survey records a public dsh-agent-team use of
`claudeInstallation`. That contradicts treating every standalone installation
reader as unused, so this export remains. Public usage evidence is finite;
this audit does not claim there are no unknown consumers.

An independent read-only review resolved all 27 public source entrypoints.
The final audit after restoring runtime-author SPI records 109 unique
removals and 777 retained export occurrences. Retained declarations are
unchanged. None of the five retired helper types is used by the fresh Raft
or Ferry snapshots.

## Preserved host surface

Airwing's values `defaultRuntimes`, `orient`, `openVoyage`,
`createRuntimeRegistry`, `defineRuntime` and `promptAndWait` remain. Its types
`Runtime`, `RuntimeRegistry`, `Session`, `SessionOptions`, `Event`,
`DeliverResult`, `TurnOutcome`, `VoyageRecorder`, `Orientation`,
`OrientationDepth`, `OrientOptions`, `RuntimeOrientation` and `Probe` remain,
including `Session.deliver`, `steer`, `resources()` and orientation results.
`scriptedRuntime`, `ScriptedTurn` and `createPiRuntime` also remain.
Runtime-author SPI is retained independently of host import counts:
`inputImagesRefusal`, `withdrawHeld` and its `HeldInput` type stay public,
including the browser-safe queue helper.

Other unapproved survey candidates stay public, including `graphOf`,
`statusOf`, `usageOf`, `turnEndAfter`, `observeAgent`, `simpleStateOf`,
`initialConversation`, `reduceConversation`, `createSubagents`,
`desktopBuildExecutables` and the shell-environment helpers. Shared contract
types such as `KnownControl`, `TaskMap` and `VoyageHeader` stay because retained
functions or types refer to them.

## Migration table

Names below are removed from every public entrypoint that previously exposed
them. Runtime objects remain available from the root and their runtime subpath.
The declaration-level list is [removed-exports.json](removed-exports.json).
Internal module paths are for OAR's own tests, not a supported host migration.

| Removed export | Replacement or ownership |
| --- | --- |
| `DSH_MINIMUM_VERSION` | Use `dshRuntime.minVersion`. |
| `FormSessionOptions` | Use the retained `SessionOptions` contract. |
| `ListingFailure` | Internal listing classifier; use the retained `ModelListing` union. |
| `PiModelCatalogOptions` | Catalog path options are internal; there is no public drop-in replacement. Use the runtime model reader for supported discovery. |
| `SUBAGENT_DEPTH_ENV` | Internal subagent recursion transport detail; use `createSubagents` options. |
| `SessionMapping` | Host-owned form mapping result; `SessionOptions` remains public. |
| `TaskEventOrigin` | Internal task reducer bookkeeping; retained public task types are unchanged. |
| `VOYAGE_FORMAT` | Use `openVoyage`; the persisted voyage format is unchanged. |
| `antigravityInstallation` | Use `antigravityRuntime.installation`. |
| `antigravityListModels` | Use `antigravityRuntime.listModels`. |
| `antigravitySession` | Use `antigravityRuntime.session`. |
| `applyTaskEvent` | Use `initialTaskState` and `reduceTaskState` over records, or `reduceTasks` over raw records. |
| `baselineForms` | Use `configForms`; the migration baseline remains an internal test fixture. |
| `claudeAccountUsage` | Use `claudeRuntime.accountUsage`. |
| `claudeListModels` | Use `claudeRuntime.listModels`. |
| `claudeSession` | Use `claudeRuntime.session`. |
| `coalesceText` | Use `session.events(observer, { coalesceText: ... })`. |
| `codebuddyInstallation` | Use `codebuddyRuntime.installation`. |
| `codebuddyListModels` | Use `codebuddyRuntime.listModels`. |
| `codebuddySession` | Use `codebuddyRuntime.session`. |
| `codexAccountUsage` | Use `codexRuntime.accountUsage`. |
| `codexInstallation` | Use `codexRuntime.installation`. |
| `codexListModels` | Use `codexRuntime.listModels`. |
| `codexRedeemLimitReset` | Use `codexRuntime.redeemLimitReset` only on an explicit host request. |
| `codexSession` | Use `codexRuntime.session`. |
| `controlActionsOf` | Read request/response records or use `initialConversation` with `reduceConversation`. |
| `controlOutcomeOf` | Internal adapter control-response helper; the public Session control results are unchanged. |
| `conversationOf` | Fold records with `initialConversation` and `reduceConversation`. |
| `createPiModelCatalog` | Use `createPiRuntime` and its `listModels` member. |
| `cursorInstallation` | Use `createCursorRuntime` with the host SDK, then its `installation` member. |
| `devinAuthStatus` | Use `devinRuntime.authStatus`. |
| `devinCheckUpdate` | Use `devinRuntime.checkUpdate`. |
| `devinInstall` | Use `devinRuntime.install`. |
| `devinInstallMethod` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `devinInstallPlan` | Use `devinRuntime.installPlan`. |
| `devinInstallation` | Use `devinRuntime.installation`. |
| `devinInstalledExecutableCandidates` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `devinListModels` | Use `devinRuntime.listModels`. |
| `devinRefusedSessionOptions` | Use `devinRuntime.refusedSessionOptions`. |
| `devinReleaseSource` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `devinSession` | Use `devinRuntime.session`. |
| `devinUpdateCheck` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `dshInstallation` | Use `dshRuntime.installation`. |
| `dshSession` | Use `dshRuntime.session`. |
| `effortOf` | Use `session.effort()`; `SessionView` also retains the observed value. |
| `endLine` | Use `VoyageRecorder.end`. |
| `eventsReader` | Use `session.events` or `eventsOf` for persisted records. |
| `factoryInstallation` | Use `factoryRuntime.installation`. |
| `factoryListModels` | Use `factoryRuntime.listModels`. |
| `factorySession` | Use `factoryRuntime.session`. |
| `grokInstallation` | Use `grokRuntime.installation`. |
| `grokListModels` | Use `grokRuntime.listModels`. |
| `grokSession` | Use `grokRuntime.session`. |
| `headerLine` | Use `openVoyage` to write the header. |
| `initialTasks` | Use `initialTaskState` for records, or an empty `TaskMap` for `reduceTasks` over raw records. |
| `isActive` | Evaluate the retained form field conditions in the host. |
| `kimiAccountDisplayName` | Use the runtime authentication/provider reader result; this extraction helper is internal. |
| `kimiAccountEmail` | Use the runtime authentication/provider reader result; this extraction helper is internal. |
| `kimiAccountUsage` | Use `kimiRuntime.accountUsage`. |
| `kimiInstallation` | Use `kimiRuntime.installation`. |
| `kimiListModels` | Use `kimiRuntime.listModels`. |
| `kimiSession` | Use `kimiRuntime.session`. |
| `listedModels` | Read the retained `ModelListing` union directly. |
| `modelOf` | Use `session.model()`; `SessionView` also retains the observed value. |
| `morphBrand` | Read the created Morph runtime's `brand`. |
| `observeConversation` | Subscribe to `session.rawEvents` and apply `reduceConversation`. |
| `observeSessionView` | Subscribe to `session.rawEvents` and apply `reduceSessionView`; see the Pi Durable demo. |
| `opencodeInstallation` | Use `opencodeRuntime.installation`. |
| `opencodeListModels` | Use `opencodeRuntime.listModels`. |
| `opencodeSession` | Use `opencodeRuntime.session`. |
| `parseDevinAuthStatus` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `piInstallation` | Use `piRuntime.installation`. |
| `piListModels` | Use `piRuntime.listModels`. |
| `piSession` | Use `piRuntime.session`. |
| `projectAntigravityModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectClaudeModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectCodebuddyModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectCodexModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectCodexUsage` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectCursorModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectDevinModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectFactoryModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectGrokModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectKimiModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectKimiUsage` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectMorphModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectOpencodeModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectPiModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectQoderModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `projectQwenModels` | Internal pure native-data projection; hosts use the runtime reader and its shared result. Regression tests still exercise the pure function internally. |
| `qoderInstallation` | Use `qoderRuntime.installation`. |
| `qoderListModels` | Use `qoderRuntime.listModels`. |
| `qoderSession` | Use `qoderRuntime.session`. |
| `qwenInstallation` | Use `qwenRuntime.installation`. |
| `qwenListModels` | Use `qwenRuntime.listModels`. |
| `qwenSession` | Use `qwenRuntime.session`. |
| `readDevinAuthStatus` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `readDevinDistribution` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `readDevinVersion` | Internal Devin discovery/parser detail; use `devinRuntime.installation`, `installPlan`, `authStatus` or `checkUpdate` for the corresponding observation. |
| `recordLine` | Use `VoyageRecorder.record`. |
| `reduceSessionViewEvent` | Use `reduceSessionView` over raw records. |
| `reduceSessionViewInput` | Use `reduceSessionView` over raw records, including input request records. |
| `serviceTierOf` | Use `session.serviceTier()`; `SessionView` also retains the observed value. |
| `stallOf` | Use `observeStalls` for host stall observation. |
| `statusValue` | Use `session.status().value` for display; persist the complete `StatusState` for incremental reduction. |
| `toModelListing` | Build the retained `ModelListing` data in the host from `ListModelsResult`. |
| `toSessionOptions` | Map the retained form data to `SessionOptions` in the host. |
| `validateConfig` | Validate the retained form data in the host; native runtime validation remains authoritative. |
| `viewOf` | Fold raw records with `initialSessionView` and `reduceSessionView`. |

## Reproduce and validate

From this checkout, run the read-only export/import audit against host snapshots:

```sh
node experiments/public-api-sweep-2026-11-16/audit.mjs --host raft=/path/to/raft-source --host ferry=/path/to/ferry
CI=1 pnpm run check
pnpm run clean-install
```

The retained [audit result](audit-result.json) records the checked worktree
and host revisions. The audit prints revisions, counts and missing imported names. Namespace and
dynamic imports are explicitly reported for inspection instead of silently
counted as compatible. Host source and credential values are not emitted.

OAR's native probes now call the public Runtime members. Pure model projection
and Claude usage-window label tests keep their internal native-input coverage.
The Pi Durable demo subscribes to raw records and uses the retained session-view
reducer, with an explicit beginning cursor so its initial replay stays intact.
The custom-runtime kernel test and browser/forms bundle boundary tests remain.
