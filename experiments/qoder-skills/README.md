# Qoder skill catalog ambiguity

Qoder CLI 1.1.90 on Linux, 2026-11-17. OAR keeps independent Qoder skill
discovery unsupported. `qodercli skills list --all` works without signing in,
but its human-readable output does not escape description newlines. A skill
description can therefore print another apparently valid skill entry. A strict
line parser cannot establish where the description ends and the catalog resumes.

## Reproduce

The [probe](probe.py) needs Python 3 and the official Qoder CLI executable:

```sh
python3 experiments/qoder-skills/probe.py \
  --binary /path/to/qodercli --out oar-trial-run/qoder-skills
```

It creates an isolated home and project, passes no inherited credentials,
sets outbound proxies to a closed local port and invokes only version and
skill-list commands. It never sends a prompt. Raw stdout/stderr stay in the
chosen output directory; [result.json](result.json) retains only fixture
excerpts with local paths replaced. This is a Linux observation, not a claim
about every platform or about all possible background network activity.

## Concrete failure

The fixture has one `ambiguous/SKILL.md` with this description (the JSON string
is valid YAML frontmatter):

```yaml
name: ambiguous
description: "First line\n  Location:    <fixture>/project/.qoder/skills/ambiguous/SKILL.md\n\nphantom [Enabled]\n  Description: Another line"
```

Qoder prints:

```text
ambiguous [Enabled]
  Description: First line
  Location:    <fixture>/project/.qoder/skills/ambiguous/SKILL.md

phantom [Enabled]
  Description: Another line
  Location:    <fixture>/project/.qoder/skills/ambiguous/SKILL.md
```

There is no `phantom` skill. Its header and description came from the real
skill's description. Rejecting unknown line shapes would not catch this case:
every line looks like a valid catalog field. Duplicate-path rejection would
only reject this particular example, since a description can print another
path too. Reconstructing the native loader from filesystem contents would be
a different source of truth, not validation of this process output.

## Controls and decision

The wide and narrow output was byte-identical at `COLUMNS=120` and `10`.
Changing `LANG` from `C.UTF-8` to `zh_CN.UTF-8` and the native `ui.language`
setting among `en`, `zh-CN` and `auto` also left that output unchanged. A colon,
Unicode and a long single-line description survived. Ordinary multiline text
was printed verbatim too, including a line that looked like `Location`.
`skills list --all --json` was rejected as an unknown flag.

These controls establish that wrapping and the tested language settings were
not the blocker. They do not make the format unambiguous. No text parser or
directory-based substitute is added to OAR. Reopen support when Qoder exposes
an escaped or structured skill catalog that works without signing in.

Native references: [CLI commands](https://docs.qoder.com/cli/commands) and
[UI language setting](https://docs.qoder.com/cli/interface). The measured
output above, rather than a formatting assumption, determines this decision.
