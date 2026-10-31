/** Native hook inputs, kept separate from the synthetic model's replies. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export async function installDirectoryHook(options: { runtime: string; cwd: string; env: Readonly<Record<string, string>>;
  revision: "A" | "B"; command: string; journal: string; grokHookScope?: "user" | "project"; opencodeHookScope?: "user" | "project" }): Promise<string> {
  const { runtime, cwd, env, revision, command, journal } = options;
  const hooks = { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }] };
  let file: string | undefined = undefined;
  let contents: unknown = { hooks };
  let scope = "not exercised";
  if (runtime === "qoder") { file = path.join(cwd, ".qoder/settings.json"); scope = "project .qoder/settings.json"; }
  if (runtime === "codex" && env.CODEX_HOME !== undefined) { file = path.join(env.CODEX_HOME, "hooks.json"); scope = "disposable CODEX_HOME/hooks.json"; }
  if (runtime === "grok" && env.GROK_HOME !== undefined) { file = path.join(env.GROK_HOME, "hooks/directory.json"); scope = "disposable GROK_HOME/hooks/directory.json"; }
  if (runtime === "grok" && options.grokHookScope === "project") { file = path.join(cwd, ".grok/hooks/directory.json"); scope = "project .grok/hooks/directory.json"; }
  if (runtime === "antigravity") { file = path.join(cwd, ".agents/hooks.json"); contents = { directory: hooks }; scope = "project .agents/hooks.json"; }
  if (runtime === "kimi" && env.KIMI_CODE_HOME !== undefined) {
    await writeFile(path.join(env.KIMI_CODE_HOME, "config.toml"), `[[hooks]]\nevent = "PreToolUse"\nmatcher = "mcp__scope__echo"\ncommand = ${JSON.stringify(command)}\ntimeout = 10\n`, { mode: 0o600 });
    return "disposable KIMI_CODE_HOME/config.toml";
  }
  if (runtime === "opencode") {
    // V2 loads a plain object with id/setup; no package download is needed.
    const user = options.opencodeHookScope === "user";
    if (user && env.XDG_CONFIG_HOME === undefined) { throw new Error("OpenCode user plugin requires an isolated XDG_CONFIG_HOME"); }
    const root = user ? path.join(env.XDG_CONFIG_HOME ?? "", "opencode") : path.join(cwd, ".opencode");
    const directory = path.join(root, "plugins/directory-observer");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "index.ts"), [
      'import {appendFileSync} from "node:fs";',
      'export default {id:"oar.directory-observer",async setup(ctx){',
      'await ctx.tool.hook("execute.before",event=>{',
      `appendFileSync(${JSON.stringify(journal)},JSON.stringify({revision:${JSON.stringify(revision)},event})+'\\n');`,
      '});}};',
    ].join("\n"), { mode: 0o600 });
    return `${user ? "disposable XDG_CONFIG_HOME/opencode" : "project .opencode"}/plugins/directory-observer/index.ts (V2 execute.before)`;
  }
  if (file !== undefined) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(contents), { mode: 0o600 });
  }
  return scope;
}

/** Only known tool-input fields can associate a hook with a probe invocation. */
export function hookInputMatches(event: unknown, input: string): boolean {
  const row = asRecord(event);
  const args = asRecord(row?.tool_input) ?? asRecord(row?.toolInput) ?? asRecord(row?.input) ?? asRecord(asRecord(row?.toolCall)?.args);
  if (args?.text === input) { return true; }
  if (asRecord(args?.tool_input)?.text === input || asRecord(args?.Arguments)?.text === input) { return true; }
  // OpenCode's code-mode tool carries this exact scripted expression.
  return args?.code === `return await tools.scope.echo(${JSON.stringify({ text: input })});`;
}

/** Match the current user turn, excluding an older prompt retained in history. */
export function providerRequestsFor(requests: readonly { readonly body: unknown }[], input: string): unknown[] {
  return requests.filter(({ body }) => {
    const row = asRecord(body);
    const messages = row?.messages ?? row?.contents ?? row?.input;
    if (!Array.isArray(messages)) { return false; }
    const last = messages.map((message) => asRecord(message)).findLast((message) => message?.role === "user" && /ACP_SHARE_[AB]_[a-z]+/u.test(JSON.stringify(message)));
    return /ACP_SHARE_(?<key>[AB]_[a-z]+)/u.exec(JSON.stringify(last))?.groups?.key === input;
  });
}
