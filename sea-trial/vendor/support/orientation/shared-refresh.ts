import assert from "node:assert/strict";
import { watch } from "node:fs";
import { claudeConfigurationFixture, type ClaudeConfigurationFixture } from "../user-configuration/claude-fixture.js";
import { TOKEN, ROTATED } from "../user-configuration/claude-oauth.js";
import { claudeSession, promptAndWait, type Session } from "../../../../packages/oar/src/index.js";
import { asRecord } from "../../../../packages/oar/src/shared/json.js";
import { rotatingModelProxy } from "./model-rotation.js";

function observeLocks(fixture: ClaudeConfigurationFixture): { names: Set<string>; close(): void } {
  const names = new Set<string>();
  const watcher = watch(fixture.home, { recursive: true }, (_event, filename) => {
    if (filename !== null && /lock/iu.test(filename)) {
      names.add(filename.replaceAll("\\", "/").replace(/\.tmp\.[\da-f]+$/u, ".tmp.<id>"));
    }
  });
  return { names, close(): void { watcher.close(); } };
}

async function persisted(fixture: ClaudeConfigurationFixture): Promise<{ access: boolean | null; refresh: boolean | null }> {
  const contents = await fixture.readCredentials();
  if (contents === null) { return { access: null, refresh: null }; }
  const oauth = asRecord(asRecord(contents)?.claudeAiOauth);
  return { access: oauth?.accessToken === TOKEN, refresh: oauth?.refreshToken === ROTATED };
}

interface Observation {
  label: string;
  authStatus: unknown;
  locks: Set<string>;
  turn: Awaited<ReturnType<typeof promptAndWait>>;
  auth?: readonly { readonly original: boolean; readonly rotated: boolean }[];
}
async function report(fixture: ClaudeConfigurationFixture, observation: Observation): Promise<void> {
  const { label, authStatus, locks, turn, auth = fixture.model.auth } = observation;
  const stored = await persisted(fixture);
  const freshStatus = asRecord(await fixture.status());
  const statusLoggedIn = asRecord(authStatus)?.loggedIn === true;
  const completed = turn.kind === "ended" && turn.outcome.kind === "completed";
  console.log(JSON.stringify({ label, platform: process.platform, statusLoggedIn, completed,
    exchanges: fixture.oauth.seen.exchanges, profileTokenVerified: fixture.oauth.seen.verified,
    auth, stored, freshStatusLoggedIn: freshStatus?.loggedIn === true, locks: [...locks] }));
  assert.ok(statusLoggedIn && freshStatus?.loggedIn === true);
  assert.equal(fixture.oauth.seen.exchanges, 1);
  assert.ok(completed);
  assert.ok(auth.some((entry) => entry.rotated));
  assert.deepEqual(stored, { access: true, refresh: true });
}

export async function simultaneousRefresh(command: string): Promise<void> {
  const fixture = await claudeConfigurationFixture(command), locks = observeLocks(fixture);
  let session: Session | undefined = undefined;
  try {
    await fixture.expire();
    const [opening, status] = await Promise.allSettled([
      claudeSession({ kind: "available", via: "executable", command }, { cwd: fixture.cwd, env: fixture.env }), fixture.status(),
    ]);
    if (opening.status === "fulfilled") { session = opening.value; }
    assert.ok(opening.status === "fulfilled" && status.status === "fulfilled");
    session = opening.value;
    const turn = await promptAndWait(session, "shared expired credential probe", { timeoutMs: 30_000 });
    await report(fixture, { label: "simultaneous expired store", authStatus: status.value, locks: locks.names, turn });
    assert.ok(fixture.model.auth.every((entry) => entry.rotated));
  } finally { locks.close(); await session?.dispose(); await fixture.close(); }
}

export async function activeRefresh(command: string): Promise<void> {
  const fixture = await claudeConfigurationFixture(command), locks = observeLocks(fixture);
  const proxy = await rotatingModelProxy(fixture.model.url);
  let session: Session | undefined = undefined;
  try {
    session = await claudeSession({ kind: "available", via: "executable", command }, { cwd: fixture.cwd, env: { ...fixture.env, ANTHROPIC_BASE_URL: proxy.url } });
    const turn = promptAndWait(session, "active shared credential probe", { timeoutMs: 30_000 });
    void (async (): Promise<void> => { try { await turn; } catch { /* Observed after releasing the held request. */ } })();
    await proxy.waitForOldToken();
    await fixture.expire();
    const status = await fixture.status();
    proxy.release();
    await report(fixture, { label: "active request during refresh", authStatus: status, locks: locks.names, turn: await turn, auth: proxy.auth });
    assert.ok(proxy.auth.some((entry) => entry.original));
  } finally { proxy.release(); locks.close(); await session?.dispose(); await proxy.close(); await fixture.close(); }
}
