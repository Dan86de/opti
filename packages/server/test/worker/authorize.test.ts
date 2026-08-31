/**
 * The login, driven end to end the way a real MCP host drives it.
 *
 * Registration, consent, the upstream round trip, the grant, the token, and an
 * authenticated request - against the doubled upstream, so the whole loop runs
 * without a browser and without the real GitHub.
 *
 * SHORTCUT, recorded per the testing decisions: the upstream is a double. This
 * proves our half of the exchange, not GitHub's. The real round trip is
 * verified by hand against the deployed worker, once.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://opti.test";
const CLIENT_REDIRECT = "https://client.example/callback";

const manual = (url: string, init?: RequestInit) => SELF.fetch(url, { redirect: "manual", ...init });

/** Register a client the way a host does, with nobody provisioning it first. */
const registerClient = async (clientName = "A Client") => {
  const response = await manual(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret?: string };
};

const consentFor = async (clientId: string) => {
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  authorize.searchParams.set("state", "client-state-123");
  const response = await manual(authorize.toString());
  const body = await response.text();
  const state = /name="state" value="([^"]+)"/.exec(body)?.[1] ?? "";
  return { status: response.status, body, state };
};

const approve = (state: string) =>
  manual(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state }).toString(),
  });

/** Walk the redirect the double hands back, and finish at our callback. */
const completeUpstream = async (upstreamUrl: string) => {
  const upstream = await fetch(upstreamUrl, { redirect: "manual" });
  const back = new URL(upstream.headers.get("location") ?? "");
  return manual(`${ORIGIN}${back.pathname}${back.search}`);
};

describe("discovery", () => {
  it("advertises the protected resource with the audience pinned to /mcp", async () => {
    const response = await manual(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };

    expect(response.status).toBe(200);
    // The audience a token is minted for. A token issued for anything else
    // cannot be replayed here, which is the whole point of pinning it.
    expect(metadata.resource).toBe(`${ORIGIN}/mcp`);
    expect(metadata.authorization_servers).toContain(ORIGIN);
  });

  it("answers an unauthenticated MCP request with a 401 that says where to authorize", async () => {
    const response = await manual(`${ORIGIN}/mcp`);

    expect(response.status).toBe(401);
    // Story 2: a host discovers the endpoints from this header rather than
    // being configured by hand.
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });
});

describe("consent", () => {
  it("leads with where the token goes, not with what the client calls itself", async () => {
    const client = await registerClient("GitHub Official");
    const consent = await consentFor(client.client_id);

    expect(consent.status).toBe(200);
    // Both appear, but the origin is the only part the client did not choose,
    // so it must be there at all and it must come first.
    expect(consent.body).toContain("https://client.example");
    expect(consent.body).toContain("GitHub Official");
    expect(consent.body.indexOf("https://client.example")).toBeLessThan(consent.body.indexOf("GitHub Official"));
  });

  it("marks a client that has never been approved", async () => {
    const client = await registerClient();
    const consent = await consentFor(client.client_id);

    expect(consent.body).toContain("has not been approved before");
  });

  it("does not let a client write HTML into the screen with its own name", async () => {
    // The name is chosen by whoever registered the client, and it is rendered
    // on the one page where a person makes a security decision.
    const client = await registerClient('<script>alert("pwned")</script>');
    const consent = await consentFor(client.client_id);

    expect(consent.body).not.toContain("<script>alert");
    expect(consent.body).toContain("&lt;script&gt;");
  });

  it("refuses to start an authorization it did not put on the screen", async () => {
    const response = await approve(crypto.randomUUID());

    // The state is minted by us and looked up here, so it is also the consent
    // form's CSRF token: a submission that did not come from our screen has
    // nothing we can find. What must not have happened: a redirect upstream.
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("the whole login", () => {
  it("carries a host from registration to an authenticated request", async () => {
    const client = await registerClient();
    const consent = await consentFor(client.client_id);

    const approved = await approve(consent.state);
    expect(approved.status).toBe(302);
    const upstreamUrl = approved.headers.get("location") ?? "";
    expect(upstreamUrl).toContain("/login/oauth/authorize");
    // No scope is asked for: the public id and login are all an identity needs,
    // and asking for more would make the login look like a credential grant.
    expect(new URL(upstreamUrl).searchParams.get("scope")).toBe("");

    const completed = await completeUpstream(upstreamUrl);
    expect(completed.status).toBe(302);

    const clientRedirect = new URL(completed.headers.get("location") ?? "");
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(CLIENT_REDIRECT);
    expect(clientRedirect.searchParams.get("state")).toBe("client-state-123");

    const token = await manual(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: clientRedirect.searchParams.get("code") ?? "",
        redirect_uri: CLIENT_REDIRECT,
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
      }).toString(),
    });
    expect(token.status).toBe(200);
    const granted = (await token.json()) as { access_token: string };

    const authenticated = await manual(`${ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${granted.access_token}` },
    });
    const envelope = (await authenticated.json()) as { ok: boolean; value: { ownerId: string } };

    expect(authenticated.status).toBe(200);
    expect(envelope.ok).toBe(true);
    // The owner id comes from the authenticated request and from nowhere else.
    expect(envelope.value.ownerId).toMatch(/^own_[0-9a-f-]{36}$/);
  });

  it("spends the pending authorization once", async () => {
    const client = await registerClient();
    const consent = await consentFor(client.client_id);
    const upstreamUrl = (await approve(consent.state)).headers.get("location") ?? "";

    expect((await completeUpstream(upstreamUrl)).status).toBe(302);

    // Replaying the same upstream redirect must not produce a second grant.
    const replayed = await completeUpstream(upstreamUrl);
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get("location")).toBeNull();
  });

  it("refuses somebody who is not on the allowlist, and issues nothing", async () => {
    const client = await registerClient();
    const consent = await consentFor(client.client_id);
    await approve(consent.state);

    // The double is always signed in as the allowlisted owner, so a stranger is
    // reached by writing the code by hand - which is also the closest thing to
    // an attacker holding a valid upstream code.
    const response = await manual(`${ORIGIN}/callback/github?state=${consent.state}&code=code:9999:not-invited`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("NotAllowlisted");
    // What must not have happened: any redirect back to the client, which is
    // the only way an authorization code reaches it.
    expect(response.headers.get("location")).toBeNull();
  });
});
