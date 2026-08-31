/**
 * Where an owner id comes into existence, and the only place it does.
 *
 * The id is opaque and generated rather than being the provider's subject.
 * Welding identity to a provider makes a second login provider a data
 * migration: the same person arriving by email and password would be a
 * different subject, so a different owner, with everything they own on the far
 * side of it. One indirection now is the entire cost of never facing that.
 *
 * The mapping is a read keyed by something other than the owner, which is
 * normally the trigger to provision a relational store. It does not fire here:
 * this is pre-authentication state, and the grant is how the owner is learned,
 * so it is the same exception the spec already carves out for the OAuth
 * provider's own state, and it lives in the same KV.
 */
import { Data, Effect } from "effect";
import type { Failure } from "../kernel/index.ts";
import type { UpstreamIdentity } from "./Upstream.ts";

declare const OwnerIdBrand: unique symbol;

/**
 * An owner id, which cannot be written down by hand.
 *
 * The brand is the enforcement for the rule that authority never travels with a
 * caller: a plain string from an argument the sandbox passed is not an
 * `OwnerId` and will not typecheck where one is required, so the invariant is
 * checked by the build rather than by review.
 */
export type OwnerId = string & { readonly [OwnerIdBrand]: true };

export interface OwnerBindings {
  readonly OAUTH_KV: KVNamespace;
  /**
   * Who may become an owner, as `provider:subject` entries.
   *
   * A secret rather than a table: dynamic client registration in front of a
   * public upstream login otherwise hands an isolate to anyone who asks, and
   * this is the gate. Entries are provider-qualified because the identity
   * mapping is, so `12345` alone would be ambiguous the day a second provider
   * exists.
   */
  readonly OWNER_ALLOWLIST: string;
}

/** Not on the allowlist. Nothing the caller does differently will help. */
export class NotAllowlisted extends Data.TaggedError("NotAllowlisted")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The mapping could not be read or written. The login can be repeated. */
export class OwnerStoreUnavailable extends Data.TaggedError("OwnerStoreUnavailable")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "now";
}

/** `github:12345`, the form used by both the allowlist and the mapping key. */
const qualified = (identity: UpstreamIdentity) => `${identity.provider}:${identity.subject}`;

const mappingKey = (identity: UpstreamIdentity) => `identity:${qualified(identity)}`;

const allowlisted = (allowlist: string, identity: UpstreamIdentity) =>
  allowlist
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(qualified(identity));

/**
 * Resolve an upstream identity to an owner id, minting one the first time.
 *
 * The allowlist is checked on every login and not only when minting. The spec
 * asks for the narrower rule, and this is deliberately stricter: with the
 * narrow rule, removing somebody from the allowlist would leave them able to
 * log in forever, which is not what anybody editing that secret expects.
 *
 * SHORTCUT, recorded at the test: two concurrent first logins by the same new
 * identity can both mint an id, because KV has no compare-and-set and this does
 * not take a lock. At one owner the window is theoretical; the day a second
 * person can sign up, this needs to move behind something serialisable.
 */
export const resolveOwner = (
  bindings: OwnerBindings,
  identity: UpstreamIdentity,
): Effect.Effect<OwnerId, NotAllowlisted | OwnerStoreUnavailable> =>
  Effect.gen(function* () {
    if (!allowlisted(bindings.OWNER_ALLOWLIST, identity)) {
      // The qualified identity is repeated so the operator can paste it into
      // the secret. It is not sensitive: it is a public GitHub user id.
      return yield* new NotAllowlisted({ message: `${qualified(identity)} is not allowed to sign in to this OPTI` });
    }

    const key = mappingKey(identity);

    const existing = yield* Effect.tryPromise({
      try: () => bindings.OAUTH_KV.get(key),
      catch: (cause) => new OwnerStoreUnavailable({ message: `could not read the identity mapping: ${String(cause)}` }),
    });

    if (existing !== null) {
      return existing as OwnerId;
    }

    const minted = `own_${crypto.randomUUID()}` as OwnerId;

    yield* Effect.tryPromise({
      try: () => bindings.OAUTH_KV.put(key, minted),
      catch: (cause) =>
        new OwnerStoreUnavailable({ message: `could not write the identity mapping: ${String(cause)}` }),
    });

    return minted;
  });
