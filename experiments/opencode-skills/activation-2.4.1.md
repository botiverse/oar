# OpenCode 2.4.1 skill discovery during plugin startup

Starting in OpenCode 2.4.0, `GET /api/provider` returns the current catalog
while a fresh `opencode serve` location is still activating plugins. On 2.3.2, the next request saw both fixture skills and the broken
project plugin. On 2.4.1, the first plugin and skill lists could be empty;
other cold reads saw just the bundled `OpenCode` and `Report`. The same
server subsequently returned both fixture skills and the failed plugin.
The November 24 candidate jobs reproduced both OAR assertions on
[Linux](https://github.com/botiverse/oar/actions/runs/45341232470/job/138265219861),
[macOS](https://github.com/botiverse/oar/actions/runs/45341232470/job/138265219924)
and [Windows](https://github.com/botiverse/oar/actions/runs/45341232470/job/138265219854).

The upstream merge commit `ce7b4252` is an ancestor of the 2.4.0 and 2.4.1
release tags. The 2.3.2 tag predates that change. The 2.4.0 npm release
published at 09:15 UTC on November 23. Version 2.4.1 followed at 15:56 UTC. The
published 2.4.0 binary also returned zero providers, plugins and skills on
the first read of the broken-plugin fixture.
[2.3.2 handler](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/server/src/handlers/provider.ts),
[2.4.0 handler](https://github.com/anomalyco/opencode/blob/44aed4fd144611879046ae923c25541f913780ad/packages/server/src/handlers/provider.ts).

## Native controls

A Linux x64 probe started a fresh password-protected loopback server in a
directory separate from the project. Each run used isolated home and XDG
directories, one home skill and one project skill. The encoded
`x-opencode-directory` header and the `location[directory]` query both
selected the project, including the space in its name. Without either, the
response named the server's launch directory. The header and query also
selected the correct distinct project in a two-project control.
[Probe](activation-phases.py), [selected responses](activation-phases.json).

| Version and observation | Plugins | Failed plugins | Home and project skills visible |
| --- | ---: | ---: | --- |
| 2.3.2, broken local plugin, first listing after provider query | 95 | 1 | Both |
| 2.4.1, broken local plugin, first listing after provider query | 0 | 0 | Neither |
| 2.4.1, same location after the failure appeared | 101 | 1 | Both |
| 2.4.1, synthetic package request held by a loopback registry | 100 | 0 | Both |
| 2.4.1, same location after the registry returned 404 | 101 | 1 | Both |

The last two reads matter for `partial`. The first nonempty plugin list
already included the local skills, but a configured package was still
pending. Its failure was visible only after the registry answered. In a
separate run, a local plugin delayed its failure by 900 ms. The sample
scheduled for 1.3 seconds began its plugin read at 1.538 seconds and found
zero plugins. Its skill read at 1.676 seconds returned only the two bundled
skills. Times are relative to the first request on the listening server.
Neither a fixed delay nor two identical skill lists establishes completion.
[Timed plugin and skill responses](delayed-plugin.json).

To reproduce on Linux, run the broken-plugin controls and the delayed
package control with the corresponding executables. They submit no prompts.

```sh
python3 experiments/opencode-skills/activation-phases.py /path/to/2.3.2/opencode broken
python3 experiments/opencode-skills/activation-phases.py /path/to/2.4.0/opencode broken
python3 experiments/opencode-skills/activation-phases.py /path/to/2.4.1/opencode broken
python3 experiments/opencode-skills/activation-phases.py /path/to/2.4.1/opencode slow
python3 experiments/opencode-skills/activation-phases.py /path/to/2.4.1/opencode package
```

## What a one-shot reader can report

Upstream intentionally made catalog reads return their current contents
while plugins load. Its CLI polls for a nonempty plugin list on selected
one-shot commands. The server's skill endpoint test instead waits on an
in-process activation primitive. The public catalog responses used here
carry the location and its current data, with no completion marker. The
supervisor can publish locally resolved plugins before installing missing
packages. [Upstream decision](https://github.com/anomalyco/opencode/pull/63814),
[2.4.1 CLI wait](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/cli/src/services/plugin-startup.ts),
[server test](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/server/test/skill.test.ts),
[supervisor](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/core/src/plugin/supervisor.ts).

OAR runs v2 skill discovery on 2.2.7 through 2.3.x. Starting at 2.4.0
the reader returns `version_unsupported` before starting a server. The CI
baseline is 2.2.7. Reopen this gate when a published release exposes a
public, non-prompt way to establish that all configured plugins have
finished activation at the requested location. Verify it with a cold
project, a delayed successful package and a delayed failed package before
enabling the reader. Upstream tracks a related cold read by its standalone
CLI. [Upstream issue](https://github.com/anomalyco/opencode/issues/63221).

## Public events and provider-auth readiness

The 2.4.1 server has no public non-prompt signal certifying that all plugins
and skills for a location have loaded. A subscriber to unfiltered
`GET /api/event` received `server.connected`, `skill.updated` and
`plugin.updated` while a synthetic package download was held. After the
registry released the package, it received a second `plugin.updated` and
`integration.updated`. The catalog update payloads carry no pending count
or final-generation flag. Plugin rows expose `active` or `failed` for
known entries. Location reads identify the directory and project, and
`/api/debug/location` lists loaded locations. The `workspace.ready` schema
carries a workspace name. The in-process `Plugin.awaitActivation` used by
upstream's own test is outside the HTTP/SSE contract.
[Plugin states and event](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/schema/src/plugin.ts),
[skill event](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/schema/src/skill.ts),
[workspace events](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/schema/src/workspace-event.ts),
[location routes](https://github.com/anomalyco/opencode/blob/6f0514052a3c859894ad01bb14cc14dda1e44b96/packages/protocol/src/groups/location.ts).

OAR's provider-auth facade caches the registry for `loginProviders()` as
soon as both `/api/plugin` and `/api/integration` return nonempty arrays.
On both 2.4.0 and 2.4.1 that check passed with 100 plugins and 334 integrations while
the loopback registry held a package that registers a synthetic login
method. After release, a fresh integration read on the **same server**
returned 335 integrations, including the fixture. The cached menu still
omitted it. A newly opened facade included it. The probe read inventories
only and submitted no login, credential write or model prompt.
[Facade](../../packages/oar/src/runtimes/opencode/provider-auth-facade.ts),
[probe](provider-readiness.ts), [selected results](provider-readiness.json).

```sh
node --import tsx experiments/opencode-skills/provider-readiness.ts /path/to/2.4.0/opencode
node --import tsx experiments/opencode-skills/provider-readiness.ts /path/to/2.4.1/opencode
```
