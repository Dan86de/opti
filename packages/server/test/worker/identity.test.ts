/**
 * The upstream login and where an owner id comes from.
 *
 * Driven against a doubled GitHub, because the real one cannot be logged into
 * from CI and because everything worth testing here is ours: what the callback
 * does with the shape GitHub returns, who is allowed in, and whether the id an
 * owner gets is opaque and stable.
 *
 * SHORTCUT, recorded per the testing decisions: the upstream is a double, so
 * this proves our code handles a GitHub-shaped response and not that GitHub
 * sends one. The real round trip is verified by hand against the deployed
 * worker, once, which is what Slice 1's done-when describes.
 */
import { env } from "cloudflare:test";
import { Effect, type Exit } from "effect";
import { describe, expect, it } from "vitest";
import { Owner, Upstream } from "../../src/identity/index.ts";
import type { Bindings } from "../../src/index.ts";
import { Envelope } from "../../src/kernel/index.ts";
import { authorizationCode } from "./support/upstream-address.ts";

/**
 * The generated `Env` describes `wrangler.jsonc`. The pool also attaches the
 * identity bindings from `vitest.workers.config.ts`, which no generator can
 * know about, so the two are reconciled here once rather than at every call.
 */
const bindings = env as typeof env & Bindings;

/**
 * Assert on the envelope rather than on the exit, because the envelope is what
 * a caller actually sees and the tag and retry class are the parts that have to
 * survive the boundary.
 */
const envelope = async <A, E>(effect: Effect.Effect<A, E>) =>
  Envelope.fromExit((await Effect.runPromise(Effect.exit(effect))) as Exit.Exit<A, E>);

const OWNER = { subject: "4242", login: "allowlisted-owner" };
const SECOND_OWNER = { subject: "4243", login: "second-allowlisted" };
const STRANGER = { subject: "9999", login: "not-invited" };

const identity = (who: { subject: string; login: string }): Upstream.UpstreamIdentity => ({
  provider: "github",
  ...who,
});

describe("upstream login", () => {
  it("turns an authorization code into an identity", async () => {
    const result = await envelope(Upstream.exchangeCode(bindings, authorizationCode(OWNER.subject, OWNER.login)));

    expect(result).toStrictEqual({
      ok: true,
      value: { provider: "github", subject: "4242", login: "allowlisted-owner" },
    });
  });

  it("refuses a bad code even though the upstream answers 200", async () => {
    // GitHub reports a failed exchange in the body of a 200, so a client that
    // reads only the status treats a bad code as a successful login.
    const result = await envelope(Upstream.exchangeCode(bindings, "not-a-real-code"));

    expect(result).toMatchObject({ ok: false, error: { tag: "UpstreamRejected", retry: "never" } });
    // The upstream's own reason, which is the part that proves the body was
    // read. Without it this test passes on the missing access token instead and
    // would keep passing if the error field were never looked at.
    expect(result.ok === false && result.error.message).toContain("bad_verification_code");
  });

  it("refuses when the client credentials are wrong", async () => {
    const result = await envelope(
      Upstream.exchangeCode(
        { ...bindings, GITHUB_CLIENT_SECRET: "wrong-secret" },
        authorizationCode(OWNER.subject, OWNER.login),
      ),
    );

    expect(result).toMatchObject({ ok: false, error: { tag: "UpstreamRejected", retry: "never" } });
    expect(result.ok === false && result.error.message).toContain("incorrect_client_credentials");
  });

  it("classifies an unreachable upstream as worth retrying", async () => {
    // The distinction the retry class exists for: the upstream saying no is
    // final, the upstream not answering is not.
    //
    // workerd logs "Network connection lost" for the refused connection. It is
    // this test's doing and it is not a failure - do not go looking for it.
    const result = await envelope(
      Upstream.exchangeCode(
        { ...bindings, GITHUB_ORIGIN: "http://127.0.0.1:1" },
        authorizationCode(OWNER.subject, OWNER.login),
      ),
    );

    expect(result).toMatchObject({ ok: false, error: { tag: "UpstreamUnreachable", retry: "now" } });
  });

  it("never lets the access token out", async () => {
    const granted = JSON.stringify(await envelope(Upstream.exchangeCode(bindings, authorizationCode("4242", "owner"))));
    const refused = JSON.stringify(await envelope(Upstream.exchangeCode(bindings, "code:bad")));

    // The token exists for one call inside the module and is returned to
    // nobody. What must not have happened: it appears in an identity, in an
    // error, or anywhere else a caller can read.
    expect(granted).not.toContain("token:");
    expect(refused).not.toContain("token:");
    // The client secret takes the same route through the same function.
    expect(granted).not.toContain("test-client-secret");
    expect(refused).not.toContain("test-client-secret");
  });
});

describe("owner id", () => {
  it("mints an opaque id that says nothing about the identity behind it", async () => {
    const result = await envelope(Owner.resolveOwner(bindings, identity(OWNER)));

    expect(result).toMatchObject({ ok: true });
    const ownerId = result.ok ? result.value : "";

    expect(ownerId).toMatch(/^own_[0-9a-f-]{36}$/);
    // An id that carried the provider's subject would weld identity to the
    // provider, which is the migration this indirection exists to avoid.
    expect(ownerId).not.toContain(OWNER.subject);
    expect(ownerId).not.toContain(OWNER.login);
    expect(ownerId).not.toContain("github");
  });

  it("gives the same identity the same id every time", async () => {
    const first = await envelope(Owner.resolveOwner(bindings, identity(OWNER)));
    const second = await envelope(Owner.resolveOwner(bindings, identity(OWNER)));

    expect(first).toStrictEqual(second);
  });

  it("gives a different identity a different id", async () => {
    const one = await envelope(Owner.resolveOwner(bindings, identity(OWNER)));
    const other = await envelope(Owner.resolveOwner(bindings, identity(SECOND_OWNER)));

    expect(one).not.toStrictEqual(other);
  });

  it("refuses an identity that is not on the allowlist, and writes nothing", async () => {
    const result = await envelope(Owner.resolveOwner(bindings, identity(STRANGER)));

    expect(result).toMatchObject({ ok: false, error: { tag: "NotAllowlisted", retry: "never" } });

    // What must not have happened: a stranger who cannot sign in must not leave
    // an owner id behind, or the allowlist would only be delaying them.
    expect(await bindings.OAUTH_KV.get(`identity:github:${STRANGER.subject}`)).toBeNull();
  });

  it("names the identity it refused so the operator can allow it", async () => {
    const result = await envelope(Owner.resolveOwner(bindings, identity(STRANGER)));

    // A public GitHub user id, in exactly the form the allowlist secret takes.
    expect(result.ok === false && result.error.message).toContain("github:9999");
  });

  it("cannot be written down by hand", () => {
    // @ts-expect-error An OwnerId is not constructible from a plain string.
    // This is the build-time half of the rule that authority never travels with
    // a caller: an id an argument supplied will not typecheck where one is
    // required. If this line ever stops erroring, the brand has been lost.
    const forged: Owner.OwnerId = "own_00000000-0000-0000-0000-000000000000";

    expect(forged).toBeTypeOf("string");
  });
});
