/**
 * The credential boundary, end to end: the slice's done-when.
 *
 * A request to a third-party API is denied with a typed error carrying an
 * approval link, the host is approved through the operator route, and the
 * same request then succeeds - with the credential substituted on the wire
 * and never inside the isolate.
 *
 * The listener double plays the API host. Automated tests never touch
 * Todoist: the double is what lets these tests assert the request that never
 * arrived (`/count`), the request that did (`/last`), and the value the
 * isolate never saw (redaction over `/echo`). The double proves the gateway,
 * not that Todoist accepts the result; the real round trip is verified by
 * hand, once, like Slice 1's authorize flow.
 *
 * SHORTCUT, recorded per the testing decisions: the double is plain http on
 * a loopback port, which the https-only rule would refuse, so the test
 * config exempts `127.0.0.1` through `GATEWAY_INSECURE_HOSTS`. Production
 * pins that binding empty; the insecure-transport denial is proved here
 * against a non-exempt host.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LISTENER_ORIGIN } from "./support/listener-address.ts";
import { callTool, ORIGIN } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const OPERATOR_TOKEN = "test-operator-token";
const VALUE = "todoist-secret-value-1234";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

const connectionsSeen = async (): Promise<number> => Number(await (await fetch(`${LISTENER_ORIGIN}/count`)).text());
const lastOnTheWire = async (): Promise<string> => await (await fetch(`${LISTENER_ORIGIN}/last`)).text();

/**
 * An owner reachable both ways: an access token for the MCP surface, and an
 * identity mapping so the operator routes can address the same owner by
 * `github:<subject>`, the way a first login would have wired it.
 */
let nextSubject = 880000;
const mintOwner = async () => {
  const { accessToken, ownerId } = await mintAccessToken();
  const identity = `github:${nextSubject++}`;
  await env.OAUTH_KV.put(`identity:${identity}`, ownerId);
  return { accessToken, ownerId, identity };
};

const operator = async (path: string, body: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

/** The one module the whole journey reuses: deny, approve, then the same
 * request succeeds. The denial propagates uncaught on purpose, so what the
 * envelope carries is what a model would actually see. */
const JOURNEY = `import { fetch } from "opti:capabilities";
export default async () => {
  const response = await fetch("${LISTENER_ORIGIN}/echo", {
    headers: { authorization: "Bearer {{credential:todoist}}" },
  });
  return await response.text();
};`;

describe("the done-when: deny, approve, succeed", () => {
  it("walks one owner through the whole sequence", async () => {
    const { accessToken, identity } = await mintOwner();

    // 1. Nothing saved: the run stops with the command to hand over, and no
    // request crossed the wire.
    const before = await connectionsSeen();
    const unknown = await execute(accessToken, JOURNEY);
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "UnknownCredential", retry: "never" },
    });
    expect(JSON.stringify(unknown.structuredContent)).toContain("save-credential");
    expect(await connectionsSeen()).toBe(before);

    // 2. Saved but not approved: saving authorizes nothing, and the denial
    // carries the approval link pre-filled with the credential and the host.
    await operator("/admin/save-credential", { identity, name: "todoist", value: VALUE });
    const denied = await execute(accessToken, JOURNEY);
    expect(denied.structuredContent).toMatchObject({
      ok: false,
      error: {
        tag: "HostNotApproved",
        retry: "never",
        action: { kind: "approve-host", url: `${ORIGIN}/approve?credential=todoist&host=127.0.0.1` },
      },
    });
    // The message names the credential and host in plain text, so an agent
    // can relay the situation without anyone opening the link.
    const message = (denied.structuredContent as { error: { message: string } }).error.message;
    expect(message).toContain("todoist");
    expect(message).toContain("127.0.0.1");
    // Refused before the network call, not after: the wire stayed silent.
    expect(await connectionsSeen()).toBe(before);
    // The denial does not leak the thing it was protecting.
    expect(JSON.stringify(denied.structuredContent)).not.toContain(VALUE);

    // 3. Approved: the same request succeeds. The wire saw the substituted
    // value; the placeholder never left; and what the API echoed back into
    // the sandbox comes home redacted.
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "127.0.0.1" });
    const succeeded = await execute(accessToken, JOURNEY);
    expect(succeeded.isError).toBeUndefined();
    expect(await connectionsSeen()).toBe(before + 1);

    const wire = await lastOnTheWire();
    expect(wire).toContain(`Bearer ${VALUE}`);
    expect(wire).not.toContain("{{credential:todoist}}");

    const body = JSON.stringify(succeeded.structuredContent);
    expect(body).toContain("[redacted:todoist]");
    // Story 30, the whole point: the value is absent from the result even
    // though the API echoed it straight back at the sandbox.
    expect(body).not.toContain(VALUE);
  });
});

describe("policy edges", () => {
  it("keeps owners apart: one owner's approval grants a second owner nothing", async () => {
    const first = await mintOwner();
    const second = await mintOwner();
    await operator("/admin/save-credential", { identity: first.identity, name: "todoist", value: VALUE });
    await operator("/admin/approve-host", { identity: first.identity, credential: "todoist", host: "127.0.0.1" });
    await operator("/admin/save-credential", { identity: second.identity, name: "todoist", value: "other-value" });

    // Identical code, same credential name, same host - the other owner's
    // vault decides, and it says no. This is the props seal doing its job:
    // authority arrived at the gateway from the door, not from the request.
    const denied = await execute(second.accessToken, JOURNEY);

    expect(denied.structuredContent).toMatchObject({ ok: false, error: { tag: "HostNotApproved" } });
  });

  it("refuses a credentialed request that is not https, whatever the allowlist says", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: VALUE });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "plain.example" });

    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         await fetch("http://plain.example/api", { headers: { authorization: "Bearer {{credential:todoist}}" } });
         return "reached";
       };`,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "InsecureTransport", retry: "never" },
    });
  });

  // FINDING, 2026-08-31, local: redirect-following happens in the caller's
  // own fetch machinery, so the sandbox's default `redirect: "follow"` makes
  // the sandbox itself re-issue the request - through the gateway again,
  // where the new hop is scanned and policy-checked like any first request.
  // The gateway's own `redirect: "manual"` therefore shows up as "each hop
  // asks permission separately", not as "the sandbox never sees a follow".
  // These two tests pin both halves of that.
  it("does not follow a credentialed redirect itself: a manual fetch gets the 301 as data", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: VALUE });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "127.0.0.1" });
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         const response = await fetch("${LISTENER_ORIGIN}/redirect", {
           headers: { authorization: "Bearer {{credential:todoist}}" },
           redirect: "manual",
         });
         return { status: response.status, location: response.headers.get("location") };
       };`,
    );

    // Had the gateway followed, even a manual sandbox fetch would have seen
    // the target's 200. The 301 arriving as data is the gateway not
    // following.
    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { result: { status: 301, location: "/probe" } },
    });
    // Exactly one connection: the redirect target was never fetched.
    expect(await connectionsSeen()).toBe(before + 1);
  });

  it("refuses the credential at the next hop when a redirect leaves the approved host", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: VALUE });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "127.0.0.1" });
    const before = await connectionsSeen();

    // The placeholder rides a custom header on purpose: fetch strips
    // `authorization` on a cross-origin redirect, and a custom header is the
    // one that would actually follow the credential to the second host.
    // /redirect-evil answers 301 toward the same listener under the
    // `localhost` name - a different hostname, approved for nothing.
    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         await fetch("${LISTENER_ORIGIN}/redirect-evil", {
           headers: { "x-api-key": "{{credential:todoist}}" },
         });
         return "followed all the way";
       };`,
    );

    // The second hop was refused before its network call - localhost is not
    // exempt from the https rule and approved for nothing - so the follow
    // died at the gateway, not at the wire.
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "InsecureTransport", retry: "never" },
    });
    // One connection, and the wire never saw the credential leave for the
    // second host: the last probe is still the first hop.
    expect(await connectionsSeen()).toBe(before + 1);
    expect(await lastOnTheWire()).toContain("GET /redirect-evil");
  });

  it("substitutes a placeholder that arrived percent-encoded in the query string", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: VALUE });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "127.0.0.1" });

    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         const response = await fetch("${LISTENER_ORIGIN}/echo?key={{credential:todoist}}");
         return (await response.text()).split("\\r\\n")[0];
       };`,
    );

    expect(result.isError).toBeUndefined();
    // The wire saw the value in the query string - the textual protocol
    // survives workerd percent-encoding the braces.
    expect(await lastOnTheWire()).toContain(`key=${VALUE}`);
    // And the echo of it came home redacted.
    expect(JSON.stringify(result.structuredContent)).toContain("[redacted:todoist]");
  });
});

describe("the ceilings", () => {
  it("exhausts the daily execution budget with retry after, naming the reset", async () => {
    const { accessToken } = await mintOwner();
    const cheap = "export default async () => 1;";

    for (let spent = 0; spent < 4; spent++) {
      expect((await execute(accessToken, cheap)).isError).toBeUndefined();
    }
    const exhausted = await execute(accessToken, cheap);

    expect(exhausted.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "ExecutionBudgetExhausted", retry: "after" },
    });
    expect(JSON.stringify(exhausted.structuredContent)).toContain("resets at");
  });

  it("exhausts the daily fetch budget inside one run, denials included", async () => {
    const { accessToken } = await mintOwner();

    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         const outcomes = [];
         for (let i = 0; i < 5; i++) {
           try {
             const response = await fetch("${LISTENER_ORIGIN}/probe");
             outcomes.push(response.status);
           } catch (denial) {
             outcomes.push(denial._tag + ":" + denial.retry);
           }
         }
         return outcomes;
       };`,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { result: [200, 200, 200, 200, "FetchBudgetExhausted:after"] },
    });
  });
});
