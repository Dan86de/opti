/**
 * The browser half of the login: consent, the upstream round trip, and the
 * grant that comes back from it.
 *
 * This is the only surface a person looks at, so it answers in HTML rather than
 * in the envelope. The envelope exists so an agent gets one shape for success
 * and failure; a human in a browser handed a JSON error object is worse off,
 * not better, and no agent ever reaches these routes.
 *
 * The authorization request is held in KV under an opaque token rather than
 * encoded into the `state` parameter. The provider re-validates the redirect
 * URI when the grant is completed, so encoding it would not be an open redirect
 * - but a token we minted and can only look up is also the CSRF token for the
 * consent form, so nothing can start an authorization except our own screen.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Data, Effect } from "effect";
import { Owner, Upstream } from "../identity/index.ts";
import { Envelope, type Failure } from "../kernel/index.ts";
import * as Consent from "./Consent.ts";
import { escapeHtml } from "./html.ts";

export interface AuthorizeBindings extends Upstream.UpstreamBindings, Owner.OwnerBindings {
  /** Injected by the provider before it calls us. A binding, at the door. */
  readonly OAUTH_PROVIDER: OAuthHelpers;
}

/** Where GitHub sends the browser back. Must match the OAuth app exactly. */
export const CALLBACK_PATH = "/callback/github";

/** Long enough to read the screen and log in, short enough to be forgotten. */
const PENDING_TTL_SECONDS = 600;

const pendingKey = (state: string) => `pending:${state}`;
const seenClientKey = (clientId: string) => `client-seen:${clientId}`;

export class NoPendingAuthorization extends Data.TaggedError("NoPendingAuthorization")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export class UpstreamRefused extends Data.TaggedError("UpstreamRefused")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

const kv = <A>(run: () => Promise<A>, what: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new Owner.OwnerStoreUnavailable({ message: `could not ${what}: ${String(cause)}` }),
  });

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * Everything that can go wrong here is shown to a person, so it is shown as a
 * page. The tag is kept because it is the thing worth quoting in a bug report.
 */
const problemPage = (failure: Failure.Failure, status: number) =>
  html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Could not sign you in</title>` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;` +
      `font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color-scheme:light dark}` +
      `main{max-width:27rem}h1{font-size:1.15rem;margin:0 0 8px}` +
      `p{margin:0 0 12px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.7}</style>` +
      `</head><body><main><h1>Could not sign you in</h1><p>${escapeHtml(failure.message)}</p>` +
      `<p><code>${escapeHtml(failure.tag)}</code></p></main></body></html>`,
    status,
  );

/** GET /authorize - name what is being granted, and mint the pending token. */
const showConsent = (request: Request, bindings: AuthorizeBindings) =>
  Effect.gen(function* () {
    const authRequest = yield* Effect.tryPromise({
      try: () => bindings.OAUTH_PROVIDER.parseAuthRequest(request),
      catch: (cause) =>
        new NoPendingAuthorization({ message: `this is not a valid authorization request: ${String(cause)}` }),
    });

    const client = yield* Effect.tryPromise({
      try: () => bindings.OAUTH_PROVIDER.lookupClient(authRequest.clientId),
      catch: (cause) => new NoPendingAuthorization({ message: `could not look up the client: ${String(cause)}` }),
    });

    if (client === null) {
      return yield* new NoPendingAuthorization({ message: "no client is registered under that id" });
    }

    const state = crypto.randomUUID();
    yield* kv(
      () =>
        bindings.OAUTH_KV.put(pendingKey(state), JSON.stringify(authRequest), {
          expirationTtl: PENDING_TTL_SECONDS,
        }),
      "hold on to the authorization request",
    );

    const seen = yield* kv(() => bindings.OAUTH_KV.get(seenClientKey(authRequest.clientId)), "look up the client");

    return html(
      Consent.render({
        state,
        // The one thing on the page the client did not choose.
        redirectOrigin: new URL(authRequest.redirectUri).origin,
        clientName: client.clientName ?? "an unnamed client",
        firstTime: seen === null,
      }),
    );
  });

/** POST /authorize - approved, so hand the browser to the upstream. */
const startUpstream = (request: Request, bindings: AuthorizeBindings) =>
  Effect.gen(function* () {
    const form = yield* Effect.tryPromise({
      try: () => request.formData(),
      catch: () => new NoPendingAuthorization({ message: "that form submission could not be read" }),
    });

    const state = String(form.get("state") ?? "");
    // A state we did not mint is a request that did not come from our screen.
    const pending = yield* kv(() => bindings.OAUTH_KV.get(pendingKey(state)), "read the authorization request");
    if (pending === null) {
      return yield* new NoPendingAuthorization({
        message: "that authorization has expired or was already used. Start again from your client.",
      });
    }

    const upstream = new URL(`${bindings.GITHUB_ORIGIN}/login/oauth/authorize`);
    upstream.searchParams.set("client_id", bindings.GITHUB_CLIENT_ID);
    upstream.searchParams.set("redirect_uri", new URL(CALLBACK_PATH, request.url).toString());
    upstream.searchParams.set("state", state);
    // No scope: the public id and login are all an identity needs, and asking
    // for more would make the login grant look like the credential grant.
    upstream.searchParams.set("scope", "");

    return Response.redirect(upstream.toString(), 302);
  });

/** GET /callback/github - the upstream came back, so finish the grant. */
const completeUpstream = (request: Request, bindings: AuthorizeBindings) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";

    if (url.searchParams.has("error")) {
      return yield* new UpstreamRefused({
        message: `the upstream refused the sign-in: ${url.searchParams.get("error")}`,
      });
    }

    const pending = yield* kv(() => bindings.OAUTH_KV.get(pendingKey(state)), "read the authorization request");
    if (pending === null) {
      return yield* new NoPendingAuthorization({
        message: "that authorization has expired or was already used. Start again from your client.",
      });
    }
    // Single use. A code replayed against a spent state gets nothing.
    yield* kv(() => bindings.OAUTH_KV.delete(pendingKey(state)), "clear the authorization request");

    const authRequest = JSON.parse(pending) as AuthRequest;

    const identity = yield* Upstream.exchangeCode(bindings, code);
    const ownerId = yield* Owner.resolveOwner(bindings, identity);

    const { redirectTo } = yield* Effect.tryPromise({
      try: () =>
        bindings.OAUTH_PROVIDER.completeAuthorization({
          request: authRequest,
          userId: ownerId,
          metadata: {},
          scope: authRequest.scope,
          // What every authenticated request will see. The owner id is sealed
          // here, so linking a second provider later does not invalidate it.
          // `login` is for screens and messages, never for identity.
          props: { ownerId, login: identity.login },
        }),
      catch: (cause) =>
        new NoPendingAuthorization({ message: `the authorization could not be completed: ${String(cause)}` }),
    });

    yield* kv(
      () => bindings.OAUTH_KV.put(seenClientKey(authRequest.clientId), "1"),
      "record that this client has been approved",
    );

    return Response.redirect(redirectTo, 302);
  });

/**
 * The routes a person looks at, and nothing else.
 *
 * Returns `null` for anything that is not one of them, so the entry point keeps
 * answering unknown routes in the envelope. The HTML stops exactly where the
 * human does.
 */
export const handle = (request: Request, bindings: AuthorizeBindings): Effect.Effect<Response | null> => {
  const url = new URL(request.url);

  const route =
    url.pathname === "/authorize" && request.method === "GET"
      ? showConsent(request, bindings)
      : url.pathname === "/authorize" && request.method === "POST"
        ? startUpstream(request, bindings)
        : url.pathname === CALLBACK_PATH
          ? completeUpstream(request, bindings)
          : null;

  if (route === null) {
    return Effect.succeed(null);
  }

  // Reuse the kernel's encoding rather than a second one: a modelled failure
  // keeps its tag and is the caller's problem, and only an unmodelled throw
  // becomes `Unexpected`, which is the one that is ours.
  return Effect.exit(route).pipe(
    Effect.map((exit) => {
      const envelope = Envelope.fromExit(exit);
      return envelope.ok
        ? envelope.value
        : problemPage(envelope.error, envelope.error.tag === "Unexpected" ? 500 : 400);
    }),
  );
};
