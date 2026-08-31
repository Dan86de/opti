/**
 * The operator surface: the only way a host gets approved or a credential
 * gets saved, under its own token and never under OAuth. The negative
 * assertions carry the weight - the write that did not happen on a bad
 * token, the owner that was not minted for an identity nobody logged in
 * with.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { vaultFor } from "../../src/vault/OwnerVault.ts";
import { ORIGIN } from "./support/mcp.ts";
import { mintedOwnerId } from "./support/token.ts";

const OPERATOR_TOKEN = "test-operator-token";

/** Wire an identity to an owner the way a first login would. */
const linkIdentity = async (subject: string): Promise<string> => {
  const ownerId = mintedOwnerId();
  await env.OAUTH_KV.put(`identity:github:${subject}`, ownerId);
  return ownerId;
};

const call = (path: string, body: unknown, token: string | null = OPERATOR_TOKEN) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

describe("authentication", () => {
  it("refuses a wrong token, and nothing is written", async () => {
    const ownerId = await linkIdentity("990001");

    const response = await call(
      "/admin/save-credential",
      { identity: "github:990001", name: "todoist", value: "secret-value" },
      "not-the-token",
    );

    expect(response.status).toBe(401);
    // The request that must not have had an effect: the vault holds nothing.
    expect(await vaultFor(env.OWNER_VAULT, ownerId).listCredentials()).toStrictEqual([]);
  });

  it("refuses a missing token outright", async () => {
    const response = await call(
      "/admin/approve-host",
      { identity: "github:1", credential: "x", host: "h.example" },
      null,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { tag: "OperatorUnauthorized" } });
  });
});

describe("addressing owners", () => {
  it("refuses an identity nobody has logged in with, without minting one", async () => {
    const response = await call("/admin/save-credential", {
      identity: "github:990404",
      name: "todoist",
      value: "secret-value",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { tag: "UnknownIdentity" } });
    // The operator surface reads the mapping and deliberately cannot create
    // one: an owner only ever comes into existence through a login.
    expect(await env.OAUTH_KV.get("identity:github:990404")).toBeNull();
  });
});

describe("the two writes", () => {
  it("saves a credential and approves a host, visible through the vault", async () => {
    const ownerId = await linkIdentity("990002");

    const saved = await call("/admin/save-credential", {
      identity: "github:990002",
      name: "todoist",
      value: "todoist-secret-value",
    });
    expect(await saved.json()).toMatchObject({ ok: true, value: { saved: "todoist" } });

    // Saving authorized nothing: the allowlist is still empty.
    expect(await vaultFor(env.OWNER_VAULT, ownerId).listCredentials()).toStrictEqual([{ name: "todoist", hosts: [] }]);

    const approved = await call("/admin/approve-host", {
      identity: "github:990002",
      credential: "todoist",
      host: "API.Todoist.com",
    });
    expect(await approved.json()).toMatchObject({
      ok: true,
      value: { approved: { credential: "todoist", host: "api.todoist.com" } },
    });

    expect(await vaultFor(env.OWNER_VAULT, ownerId).listCredentials()).toStrictEqual([
      { name: "todoist", hosts: ["api.todoist.com"] },
    ]);
  });

  it("refuses a credential name the placeholder protocol cannot spell", async () => {
    const ownerId = await linkIdentity("990003");

    const response = await call("/admin/save-credential", {
      identity: "github:990003",
      name: "Todoist Token",
      value: "secret-value",
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("[a-z0-9._-]");
    expect(await vaultFor(env.OWNER_VAULT, ownerId).listCredentials()).toStrictEqual([]);
  });

  it("refuses a host that is not an exact hostname", async () => {
    await linkIdentity("990005");

    for (const host of ["https://api.todoist.com", "api.todoist.com:443", "*.todoist.com", "api.todoist.com/rest"]) {
      const response = await call("/admin/approve-host", {
        identity: "github:990005",
        credential: "todoist",
        host,
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("the approval page", () => {
  it("renders the grant in plain words before the command, with no auth", async () => {
    const response = await SELF.fetch(`${ORIGIN}/approve?credential=todoist&host=api.todoist.com`);

    expect(response.status).toBe(200);
    const html = await response.text();
    // The grant leads; the command follows and names the exact arguments.
    expect(html.indexOf("todoist")).toBeGreaterThan(-1);
    expect(html.indexOf("Approve egress")).toBeLessThan(html.indexOf("operator.sh"));
    expect(html).toContain("approve-host &lt;your-upstream-identity&gt; todoist api.todoist.com");
  });

  it("renders no command for a pair the protocol cannot spell", async () => {
    const response = await SELF.fetch(`${ORIGIN}/approve?credential=<script>alert(1)</script>&host=x`);

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("operator.sh");
  });
});
