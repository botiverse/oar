/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/require-array-sort-compare -- Standalone multi-version JavaScript probe dynamically imports an arbitrary installed SDK; production inventory is typed separately. */
// Native Pi SDK inventory. Never prompts; session history stays in memory.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sdkUrl = typeof process.argv[3] === "string" ? pathToFileURL(resolve(process.argv[3], 'dist/index.js')).href : import.meta.resolve('@earendil-works/pi-coding-agent');
const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import(sdkUrl);
const sdkDir = dirname(fileURLToPath(sdkUrl));
const packagePath = resolve(sdkDir, '../package.json');
const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
const cwd = process.argv[2] ?? process.cwd();
const services = await createAgentSessionServices({ cwd });
const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
function inventory(rows) {
  return { count: rows.length, fields: [...new Set(rows.flatMap(row => Object.keys(row)))].toSorted() };
}
try {
  const loader = session.resourceLoader;
  const skills = loader.getSkills();
  const tools = session.getAllTools();
  const active = new Set(session.getActiveToolNames());
  const builtins = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
  console.log(JSON.stringify({ runtime: 'pi', version, surface: 'native SDK',
    skills: { ...inventory(skills.skills), diagnostics: skills.diagnostics.length },
    tools: { ...inventory(tools), activeCount: active.size,
      withParameters: tools.filter(tool => tool.parameters !== null && tool.parameters !== undefined).length,
      activeBuiltins: [...active].filter(name => builtins.has(name)).toSorted(),
      otherActiveCount: [...active].filter(name => !builtins.has(name)).length },
    extensions: { loaded: loader.getExtensions().extensions.length, errors: loader.getExtensions().errors.length },
    mcp: { dedicatedInventoryApi: false, note: 'No MCP inventory API in inspected SDK declarations; extension tools can appear as tools without a standard MCP origin.' }
  }));
} finally { session.dispose(); }
