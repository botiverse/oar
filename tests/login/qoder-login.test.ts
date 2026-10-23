import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { qoderLogin } from "../../packages/oar/src/runtimes/qoder/login.js";
import { qoderAuthStatus, projectQoderAuthStatus } from "../../packages/oar/src/runtimes/qoder/auth-status.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-qoder-login-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "qodercli", script: "fake-qoder-login.mjs", state: { mode, loggedIn } });
  return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "1.1.78" } };
}

  it("reports only the explicit status boolean", () => {
    expect(projectQoderAuthStatus(JSON.stringify({ logged_in: true, email: "private@example.invalid", username: "private-user", org_id: "private-org", access_token: "private-token" }))).toMatchInlineSnapshot(`
      {
        "kind": "logged_in",
        "source": "qodercli status --output json",
      }
    `);
    expect(projectQoderAuthStatus('{"logged_in":false}').kind).toBe("logged_out");
    expect(projectQoderAuthStatus('{"username":"present"}').kind).toBe("unknown");
    expect(projectQoderAuthStatus("unexpected output").kind).toBe("unknown");
  });
  it("relays a trimmed native URL and confirms success without leaking identity", async () => {
    const { fake, installation } = await fixture("success");
    const interaction = recordedInteraction([]);
    expect(await qoderLogin(installation, interaction, { openBrowser: false })).toMatchInlineSnapshot(`
      {
        "kind": "logged_in",
      }
    `);
    expect(interaction.events).toMatchInlineSnapshot(`
      [
        {
          "instructions": "Open this URL to sign in to Qoder.",
          "kind": "auth_url",
          "url": "https://qoder.com/device/selectAccounts?challenge=synthetic-challenge",
        },
      ]
    `);
    expect(fake.read().calls).toEqual([["login"], ["status", "--output", "json"]]);
    expect(fake.read().loginBrowser).toBe("www-browser");
  });
  it("reuses a native login without requesting a new browser flow", async () => {
    const { installation } = await fixture("existing", true);
    const interaction = recordedInteraction([]);
    const result = await qoderLogin(installation, interaction);
    expect(result.kind).toBe("logged_in");
    expect(interaction.events).toEqual([]);
  });
  it("cancellation leaves the old login intact", async () => {
    const { fake, installation } = await fixture("cancel", true);
    const abort = new AbortController();
    expect(await qoderLogin(installation, { signal: abort.signal, prompt: async () => "", onEvent: () => { abort.abort(); } })).toMatchInlineSnapshot(`
      {
        "kind": "cancelled",
      }
    `);
    expect(fake.read().loggedIn).toBe(true);
  });
  it("bounds the person's wait", async () => {
    const { installation } = await fixture("timeout");
    expect(await qoderLogin(installation, recordedInteraction([]), { timeoutMs: 150 })).toMatchInlineSnapshot(`
      {
        "detail": "no sign-in within 150 ms",
        "kind": "failed",
        "reason": "timed_out",
      }
    `);
  });
  it("does not expose arbitrary native failure output", async () => {
    const { installation } = await fixture("failure");
    expect(await qoderLogin(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
      {
        "detail": "Qoder reported that login failed",
        "kind": "failed",
        "reason": "rejected",
      }
    `);
  });
  it("uses status to reject a false success", async () => {
    const { installation } = await fixture("false-success");
    expect(await qoderLogin(installation, recordedInteraction([]))).toMatchInlineSnapshot(`
      {
        "detail": "Qoder reported success but its status command reads logged out",
        "kind": "failed",
        "reason": "not_logged_in",
      }
    `);
  });
  it("keeps failed status output private and unknown", async () => {
    const { installation } = await fixture("status-error");
    expect(await qoderAuthStatus(installation)).toMatchInlineSnapshot(`
      {
        "detail": "Qoder account query ended without an answer",
        "kind": "unknown",
        "source": "qodercli status --output json",
      }
    `);
  });
