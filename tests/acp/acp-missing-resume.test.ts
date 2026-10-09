import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { SessionNotFoundError, RuntimeFailureError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import errors from "../fixtures/missing-resume-errors.json" with { type: "json" };

const nativeErrors: Readonly<Record<string, unknown>> = errors;
const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const profiles = { antigravity: antigravityAcpProfile, grok: grokAcpProfile, kimi: kimiAcpProfile, opencode: opencodeAcpProfile, opencodeV2: opencodeV2AcpProfile };
const unlisted = { result: { sessions: [] } };
const listed = { result: { sessions: [{ sessionId: "missing-session", cwd: process.cwd() }] } };
async function open(profile: AcpSessionProfile, scenario: object, resume: string | null = "missing-session") {
  return acpSession({ ...profile, args: [fileURLToPath(new URL("../fixtures/fake-acp-missing-resume.mjs", import.meta.url))] })(installation, {
    cwd: process.cwd(), ...(resume === null ? {} : { resume }), env: { FAKE_RESUME_CASE: JSON.stringify(scenario) },
  });
}

// These recorded answers and versions are documented beside the mapping in runtime-matrix.md.
test.each(Object.entries(profiles))("%s maps its recorded missing resume error", async (runtime, profile) => {
  const native = nativeErrors[runtime];
  const failure: unknown = await open(profile, { error: native, pages: [unlisted] }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ name: "SessionNotFoundError", sessionId: "missing-session", cause: { method: "session/resume", native } });
});

test("antigravity uses the same structural signal on session/load", async () => {
  const opening = open(profiles.antigravity, { error: errors.antigravity, capability: "load", errorMethod: "session/load" });
  await expect(opening).rejects.toBeInstanceOf(SessionNotFoundError);
  await expect(opening).rejects.toMatchObject({ cause: { method: "session/load", native: errors.antigravity } });
});

test.each(Object.entries(profiles))("%s never classifies an initialize or new-session error as a missing resume", async (runtime, profile) => {
  for (const errorMethod of ["initialize", "session/new"]) {
    // oxlint-disable-next-line no-await-in-loop -- Each independent open is fully cleaned up before the next.
    const failure: unknown = await open(profile, { error: nativeErrors[runtime], errorMethod }, null).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  }
});

const listProfiles = [profiles.kimi, profiles.opencode, profiles.opencodeV2];
test.each(listProfiles)("a listed id keeps a generic native resume failure, even on a later page", async (profile) => {
  const failure: unknown = await open(profile, { error: errors.opencode, pages: [{ result: { sessions: [], nextCursor: "next" } }, listed] }).catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ cause: { method: "session/resume", native: errors.opencode } });
});

test.each(listProfiles)("complete pagination with no match proves absence only when resume fails", async (profile) => {
  const scenario = { error: errors.opencode, pages: [{ result: { sessions: [], nextCursor: "next" } }, unlisted] };
  await expect(open(profile, scenario)).rejects.toBeInstanceOf(SessionNotFoundError);
  const session = await open(profile, { ...scenario, succeed: true });
  expect(session.id).toBe("missing-session");
  await session.dispose();
});

test.each(listProfiles)("a real id in another cwd is still an UnsupportedOptionError", async (profile) => {
  const opening = open(profile, { error: errors.opencode, pages: [{ result: { sessions: [{ sessionId: "missing-session", cwd: `${process.cwd()}/other` }] } }] });
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({ option: "cwd" });
});

test.each([
  { list: false },
  { pages: [{ result: {} }] },
  { pages: [{ result: { sessions: [null] } }] },
  { pages: [{ result: { sessions: [{}] } }] },
  { pages: [{ result: { sessions: [], nextCursor: 7 } }] },
  { pages: [{ result: { sessions: [], nextCursor: "repeated" } }] },
  { pages: [{ result: { sessions: [], nextCursor: "next" } }, { error: { code: -32_603, message: "list failed" } }] },
])("an unavailable, incomplete or malformed list never proves absence: %j", async (scenario) => {
  const failure: unknown = await open(profiles.opencode, { ...scenario, error: errors.opencode }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SessionNotFoundError);
});

test.each(listProfiles)("an authentication failure keeps its classification despite an empty list", async (profile) => {
  const opening = open(profile, { pages: [unlisted], error: { code: -32_000, message: "Authentication required" } });
  await expect(opening).rejects.toBeInstanceOf(RuntimeFailureError);
  await expect(opening).rejects.toMatchObject({ failure: "auth" });
});

test.each([
  [profiles.antigravity, { ...errors.antigravity, code: -32_603 }],
  [profiles.grok, { ...errors.grok, data: { code: "FS_ACCESS_DENIED" } }],
  [{ args: [], capabilities: { queue: { durable: false }, attribution: "opaque" } } satisfies AcpSessionProfile, errors.antigravity],
] as const)("other native failures and profiles without a rule stay unchanged", async (profile, native) => {
  const failure: unknown = await open(profile, { error: native, pages: [unlisted] }).catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ cause: { native } });
});

test("a mapped error remains typed after credential redaction, with a JSON-safe native cause", async () => {
  const secret = "resume-missing-secret-sentinel";
  const native = { ...errors.grok, data: { ...errors.grok.data, detail: secret } };
  const session = acpSession({ ...profiles.grok, args: [fileURLToPath(new URL("../fixtures/fake-acp-missing-resume.mjs", import.meta.url))] });
  const failure: unknown = await session(installation, { cwd: process.cwd(), resume: "missing-session", env: { API_KEY: secret, FAKE_RESUME_CASE: JSON.stringify({ error: native }) } }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(inspect(failure, { depth: null })).not.toContain(secret);
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Persistence is the boundary under test.
  expect(JSON.parse(JSON.stringify(failure instanceof Error ? failure.cause : null))).toMatchObject({ method: "session/resume", native: { data: { code: "FS_NOT_FOUND", detail: "[redacted]" } } });
});
