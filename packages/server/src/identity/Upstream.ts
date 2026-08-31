/**
 * The upstream login.
 *
 * GitHub is deliberately unrelated to any service OPTI will later hold a
 * credential for. Logging in and holding a credential are two separate grants,
 * and keeping the identity provider out of the set of services we call keeps
 * that separation structural rather than remembered.
 *
 * This module turns an authorization code into an identity and nothing else. It
 * does not decide who is allowed in and it does not mint an owner id; both of
 * those belong to `Owner`, which is the only place an `OwnerId` comes from.
 */
import { Data, Effect } from "effect";
import type { Failure } from "../kernel/index.ts";

/**
 * What this module needs, and nothing more.
 *
 * The origins are configuration rather than constants so that the doubled
 * upstream in the tests is reached the same way the real one is - through the
 * door - which is what keeps a test-only code path out of the deployed worker.
 */
export interface UpstreamBindings {
  readonly GITHUB_ORIGIN: string;
  readonly GITHUB_API_ORIGIN: string;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
}

/**
 * Who the upstream says this is.
 *
 * `subject` is the provider's immutable id, never the login: a GitHub login can
 * be changed by its owner and then claimed by somebody else, so an identity
 * keyed on it is an identity that can be taken over. `login` is carried for
 * screens and messages only.
 */
export interface UpstreamIdentity {
  readonly provider: "github";
  readonly subject: string;
  readonly login: string;
}

/** The upstream could not be reached. Repeating the whole login may work. */
export class UpstreamUnreachable extends Data.TaggedError("UpstreamUnreachable")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "now";
}

/** The upstream answered, and said no. Repeating the same code cannot help. */
export class UpstreamRejected extends Data.TaggedError("UpstreamRejected")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** GitHub refuses an API request without one, so it is not decoration. */
const USER_AGENT = "opti";

const request = (input: string, init: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(input, init),
    catch: (cause) => new UpstreamUnreachable({ message: `could not reach the upstream: ${String(cause)}` }),
  });

/**
 * The two payload shapes the upstream can answer with.
 *
 * Declared rather than read off an index signature, so every field access is a
 * field the upstream is documented to send. Both are `unknown` because the
 * upstream is not ours: what arrives is checked below rather than trusted.
 */
interface TokenPayload {
  readonly access_token?: unknown;
  readonly error?: unknown;
}

interface UserPayload {
  readonly id?: unknown;
  readonly login?: unknown;
}

const body = <T>(response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<T>,
    catch: () => new UpstreamRejected({ message: "the upstream answered with something that was not JSON" }),
  });

/**
 * Trade the authorization code for an access token.
 *
 * A failed exchange arrives as HTTP 200 carrying an `error` field, which is
 * GitHub's shape and not ours. A client that only reads the status treats a bad
 * code as a successful login, so the body is what decides here.
 */
const accessToken = (bindings: UpstreamBindings, code: string) =>
  Effect.gen(function* () {
    const response = yield* request(`${bindings.GITHUB_ORIGIN}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: bindings.GITHUB_CLIENT_ID,
        client_secret: bindings.GITHUB_CLIENT_SECRET,
        code,
      }).toString(),
    });

    const payload = yield* body<TokenPayload>(response);

    if (typeof payload.error === "string") {
      // The upstream's own error code is safe to repeat; the code and the
      // client secret are not, so neither is interpolated here.
      return yield* new UpstreamRejected({
        message: `the upstream refused the authorization code: ${payload.error}`,
      });
    }
    if (typeof payload.access_token !== "string") {
      return yield* new UpstreamRejected({ message: "the upstream returned no access token" });
    }
    return payload.access_token;
  });

/**
 * Ask who the token belongs to.
 *
 * The token never leaves this function. It is not returned, not logged, and not
 * put in an error: an identity is all the caller needs, and a token that is
 * never handed out cannot be leaked by someone downstream.
 */
const identify = (bindings: UpstreamBindings, token: string) =>
  Effect.gen(function* () {
    const response = yield* request(`${bindings.GITHUB_API_ORIGIN}/user`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
    });

    if (!response.ok) {
      return yield* new UpstreamRejected({ message: `the upstream refused the access token (${response.status})` });
    }

    const payload = yield* body<UserPayload>(response);

    if (typeof payload.id !== "number" || typeof payload.login !== "string") {
      return yield* new UpstreamRejected({ message: "the upstream returned a user without an id and a login" });
    }

    return { provider: "github", subject: String(payload.id), login: payload.login } as const;
  });

/** The whole upstream leg: a code in, an identity out, no token in between. */
export const exchangeCode = (
  bindings: UpstreamBindings,
  code: string,
): Effect.Effect<UpstreamIdentity, UpstreamUnreachable | UpstreamRejected> =>
  Effect.gen(function* () {
    const token = yield* accessToken(bindings, code);
    return yield* identify(bindings, token);
  });
