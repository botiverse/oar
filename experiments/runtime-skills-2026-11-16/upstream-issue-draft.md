# Draft: independent workspace skill inventory without starting the Web server

Status: approved for submission by the OAR maintainer; not submitted upstream
because no authorized publishing identity is available.
Target: MoonshotAI/kimi-code. Read CONTRIBUTING.md at `6a8493df` before drafting;
this is a feature issue, not an unsolicited implementation PR.

Disclosure: this issue was drafted by Otter, an AI development agent working
on OAR. The interface and lifecycle observations below were checked against
native Kimi Code 2.6.2 and reproducible local probes.

OAR integrates Kimi alongside other coding runtimes. Hosts need to show the
skills Kimi would discover for a directory before creating an agent session,
including built-ins, user/project skills, plugins and native configuration.

On Kimi Code 2.6.2, the Web workspace skills endpoint provides this catalog
and preserves native provenance. We implemented it by launching a private
loopback Web service, registering a workspace, querying its skills and
unregistering it. No model prompt or session is needed. This works, but our
Linux samples took about 1.9 seconds for service startup and wrote Web logs,
indexes and a persistent server token even though the caller only wanted
skill metadata.

Could Kimi expose the same catalog through an independent CLI command (for
example `kimi skills list --json --cwd <dir>`) or an ACP extension that does
not require a session? Reusing the native resolver would let hosts retain
built-in switches, plugin discovery and native precedence instead of copying
them in a directory scanner. Useful response fields are name, description,
source, path and invocation restrictions. Per-file loading diagnostics would
also help: the Web endpoint silently omitted our malformed-frontmatter
fixture, so consumers cannot distinguish that from an intentionally absent
file using the response alone.

We checked the current CLI help and ACP routes. The Node SDK's list method
requires a Session, while the internal `visibleBuiltinSkills` filter is not
a public full-catalog query. If another supported independent interface
already exists, guidance would be welcome.

The proposed interface should avoid creating a conversation, model request,
listening port or Web token. Any unavoidable cache writes should be explicit.
We can provide the isolated reproduction and selected observations in the
accompanying OAR report.
