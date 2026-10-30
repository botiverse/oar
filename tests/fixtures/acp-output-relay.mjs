/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Standalone untyped subprocess fixture relays raw protocol lines. */
/** A separate output writer can exit while the fake agent remains alive. */
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'fixture/break-output') {
    process.stdout.write('', () => process.exit(0));
  } else {
    process.stdout.write(`${line}\n`);
  }
});
lines.on('close', () => process.stdout.end());
