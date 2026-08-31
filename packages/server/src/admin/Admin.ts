/**
 * The operator surface: admin routes on the worker outside `/mcp`, called by
 * a thin script, because there is no other way into a durable object from a
 * laptop.
 *
 * Authenticated by an `OPERATOR_TOKEN` worker secret compared in constant
 * time, deliberately not OAuth: the operator is not an MCP client, and
 * separate routes under a separate token are what make approval structurally
 * unreachable from every agent surface. The sandbox cannot even probe these
 * routes, because the gateway refuses the worker's own origin as a class.
 *
 * This module is the sole caller of the vault's two write methods - the host
 * policy's `approveHost` and the credential store's `putCredential` - and the
 * import-boundary test is what keeps that true by build rather than review.
 */
import { Data, Effect, Schema } from "effect";
import { Owner } from "../identity/index.ts";
import { Envelope, type Failure } from "../kernel/index.ts";
import { type OwnerVault, vaultFor } from "../vault/OwnerVault.ts";

export interface AdminBindings {
  /**
   * The operator's token, a worker secret. Empty means no operator: every
   * call is refused, so a deployment that forgot the secret fails closed.
   */
  readonly OPERATOR_TOKEN: string;
  readonly OAUTH_KV: KVNamespace;
  readonly OWNER_VAULT: DurableObjectNamespace<OwnerVault>;
}

/** Wrong or missing token. The message does not say which. */
export class OperatorUnauthorized extends Data.TaggedError("OperatorUnauthorized")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The qualified identity maps to no owner. Log in once first. */
export class UnknownIdentity extends Data.TaggedError("UnknownIdentity")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export class MalformedAdminRequest extends Data.TaggedError("MalformedAdminRequest")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * An allowlist entry is an exact hostname: no scheme, no port, no path, no
 * wildcards. Refusing the rest here keeps the stored policy boring.
 */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

const ApproveHost = Schema.Struct({
  identity: Schema.String,
  credential: Schema.String,
  host: Schema.String,
});

const SaveCredential = Schema.Struct({
  identity: Schema.String,
  name: Schema.String,
  value: Schema.String,
});

const decodeApproveHost = Schema.decodeUnknownEffect(ApproveHost);
const decodeSaveCredential = Schema.decodeUnknownEffect(SaveCredential);

const encoder = new TextEncoder();

/**
 * Constant-time comparison over digests: hashing first makes the comparison
 * fixed-length, so neither content nor length leaks through timing.
 */
const sameToken = (presented: string, expected: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(presented)),
      crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    return crypto.subtle.timingSafeEqual(a, b);
  });

const authorize = (request: Request, bindings: AdminBindings): Effect.Effect<void, OperatorUnauthorized> =>
  Effect.gen(function* () {
    const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const configured = bindings.OPERATOR_TOKEN;
    const matches = configured.length > 0 && (yield* sameToken(presented, configured));
    if (!matches) {
      return yield* new OperatorUnauthorized({ message: "this route needs the operator token" });
    }
  });

const body = (request: Request): Effect.Effect<unknown, MalformedAdminRequest> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new MalformedAdminRequest({ message: "the body is not JSON" }),
  });

const resolveOwner = (bindings: AdminBindings, identity: string) =>
  Effect.gen(function* () {
    const ownerId = yield* Owner.lookupOwner(bindings, identity);
    if (ownerId === null) {
      return yield* new UnknownIdentity({
        message: `${identity} maps to no owner. An owner exists only after a first login.`,
      });
    }
    return ownerId;
  });

const approveHost = (request: Request, bindings: AdminBindings) =>
  Effect.gen(function* () {
    const input = yield* decodeApproveHost(yield* body(request)).pipe(
      Effect.mapError(
        () => new MalformedAdminRequest({ message: "approve-host needs identity, credential and host strings" }),
      ),
    );
    if (!HOST_PATTERN.test(input.host) || input.host.includes("*")) {
      return yield* new MalformedAdminRequest({
        message: `a host is an exact hostname - no scheme, no port, no path, no wildcards; ${JSON.stringify(input.host)} is not one`,
      });
    }
    const ownerId = yield* resolveOwner(bindings, input.identity);
    yield* Effect.promise(() => vaultFor(bindings.OWNER_VAULT, ownerId).approveHost(input.credential, input.host));
    return { approved: { credential: input.credential, host: input.host.toLowerCase() } };
  });

const saveCredential = (request: Request, bindings: AdminBindings) =>
  Effect.gen(function* () {
    const input = yield* decodeSaveCredential(yield* body(request)).pipe(
      Effect.mapError(
        () => new MalformedAdminRequest({ message: "save-credential needs identity, name and value strings" }),
      ),
    );
    const ownerId = yield* resolveOwner(bindings, input.identity);
    const verdict = yield* Effect.promise(
      async () => await vaultFor(bindings.OWNER_VAULT, ownerId).putCredential(ownerId, input.name, input.value),
    );
    if (!verdict.saved) {
      // The vault refuses a name the placeholder protocol cannot spell; its
      // message names the pattern.
      return yield* new MalformedAdminRequest({ message: verdict.message });
    }
    // Saving authorizes nothing: the value and the permission to send it are
    // two separate grants, so the answer names no hosts.
    return { saved: input.name };
  });

const status = (tag: string): number =>
  tag === "OperatorUnauthorized" ? 401 : tag === "UnknownIdentity" ? 404 : tag === "Unexpected" ? 500 : 400;

/**
 * The two operator routes, and `null` for everything else so the entry point
 * keeps owning the not-found answer.
 */
export const handle = (request: Request, bindings: AdminBindings): Effect.Effect<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/") || request.method !== "POST") {
    return Effect.succeed(null);
  }

  const route = Effect.gen(function* () {
    yield* authorize(request, bindings);
    if (url.pathname === "/admin/approve-host") {
      return yield* approveHost(request, bindings);
    }
    if (url.pathname === "/admin/save-credential") {
      return yield* saveCredential(request, bindings);
    }
    return yield* new MalformedAdminRequest({ message: `no admin route at ${url.pathname}` });
  });

  return route.pipe(
    Effect.exit,
    Effect.map((exit) => {
      const envelope = Envelope.fromExit(exit);
      return new Response(JSON.stringify(envelope), {
        status: envelope.ok ? 200 : status(envelope.error.tag),
        headers: { "content-type": "application/json" },
      });
    }),
  );
};
