# Research with Parallel Search MCP

This runnable example attaches [Parallel Search MCP][parallel] to one Claude
Code session using OAR's `mcpServers` option. The agent can call `web_search`
for source excerpts and `web_fetch` for pages it needs to read in more depth.
The configuration includes a project User-Agent and no authorization header.
It does not write to Claude's saved MCP configuration; other configured servers
remain available in the session. A saved server also named `parallel` is
replaced only for this session.

## Run

From a checkout of OAR, with Node.js 24+ and pnpm installed:

```sh
pnpm install --frozen-lockfile
npm install -g @anthropic-ai/claude-code
claude auth login
pnpm tsx experiments/parallel-search.ts "Find the official Node.js release schedule and cite its URL."
```

Claude Code must be installed and signed in to a model provider. The example
uses the runtime's configured model. Parallel's anonymous endpoint requires no
Parallel account or API key, but has free-tier rate limits; model inference
uses your Claude provider's quota separately. See the [current limits and
search behavior][parallel].

The script prints the agent's answer to stdout and tool names to stderr, waits
up to three minutes for the turn, and disposes the session even on failure.
OAR runs Claude with its normal embedded-session permission settings
([Claude mapping](../runtimes/claude.md)); choose the working directory as you
would for any coding-agent session.

## Use in an application

Copy the `parallelSearchMcp` configuration from
[`experiments/parallel-search.ts`](../../experiments/parallel-search.ts) into
`mcpServers` when opening a Claude session. Keep the User-Agent header.
The example's appended prompt asks the agent to cite sources and reuse a
conversation identifier across related tool calls. Search excerpts are often
enough to answer; fetch is useful for a specific URL or missing detail.

Validation used native Claude Code with a scripted model provider: the agent
called search and fetch against the anonymous endpoint and received source
excerpts back. This proves tool dispatch and result delivery, not the quality
of an unscripted model's research. The vendor regression test uses a local
HTTP fixture, with no external search requests or model quota in CI.

[parallel]: https://docs.parallel.ai/integrations/mcp/search-mcp
