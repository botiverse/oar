/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone JavaScript probe across two installed DSH ABIs; injected services are checked at runtime and no DSH type/runtime package is installed in OAR. */
export const name = 'oar-dsh-load-probe';
export const inject = ['agents', 'llm', 'sessions', 'sessionPersistence'];
export async function apply(ctx) {
  process.stdin.resume();
  const imports = {};
  await Promise.all(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent'].map(async id => {
    try {
      const module = await import(id);
      imports[id] = { resolved: import.meta.resolve(id), exports: Object.keys(module) };
    } catch (error) {
      imports[id] = { error: String(error) };
    }
  }));
  process.stdout.write(`${JSON.stringify({ type: 'ready', imports, services: ['agents', 'llm', 'sessions', 'sessionPersistence'].map(id => [id, Boolean(ctx[id])]) })}\n`);
}
