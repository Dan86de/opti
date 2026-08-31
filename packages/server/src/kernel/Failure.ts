/**
 * The error taxonomy.
 *
 * This is kernel, not a module: it has no implementation to hide and
 * everything imports it. Keep it free of dependencies on anything below it.
 */
import { Data } from "effect";

/**
 * What a caller should do about a failure, so that recovery never requires
 * reading a stack trace.
 *
 * - `now`   transient. The same call may succeed if repeated immediately.
 * - `after` the condition clears with time. Wait, then repeat.
 * - `never` repeating cannot help. Something outside the caller must change.
 */
export type Retry = "now" | "after" | "never";

/**
 * Something only a human can do, carried on the failure itself so an agent can
 * hand the problem over in one message instead of looping.
 *
 * Slice 2 is the first real user: a denied host arrives here as an approval
 * link pre-filled with the credential name and the host.
 */
export interface Action {
  readonly kind: string;
  readonly url: string;
}

/**
 * The wire form of a failure. This is what crosses the boundary; the tagged
 * error classes below are what we throw internally.
 *
 * `action` is absent unless a human must intervene. An absent field means the
 * boring default, so a present field is always a signal - which is the reason
 * not to add a field here that is set on every failure.
 */
export interface Failure {
  readonly tag: string;
  readonly message: string;
  readonly retry: Retry;
  readonly action?: Action;
}

/**
 * The shape every OPTI error satisfies. A tagged error carries its own retry
 * classification, so the classification travels with the failure rather than
 * being decided by whoever happens to catch it.
 */
export interface OptiError {
  readonly _tag: string;
  readonly message: string;
  readonly retry: Retry;
  readonly action?: Action;
}

/**
 * A throw we did not model. Never retryable, because a caller repeating an
 * unmodelled failure is guessing.
 */
export class Unexpected extends Data.TaggedError("Unexpected")<{
  readonly message: string;
}> {
  readonly retry: Retry = "never";
}

const isOptiError = (u: unknown): u is OptiError =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as { _tag?: unknown })._tag === "string" &&
  typeof (u as { message?: unknown }).message === "string" &&
  typeof (u as { retry?: unknown }).retry === "string";

/**
 * Encode anything that was thrown into the wire form, preserving its tag.
 *
 * The boundary must not flatten what went wrong: an error that knew its own
 * tag arrives on the other side still knowing it. Only a value that carries no
 * tag of its own becomes `Unexpected`.
 */
export const toFailure = (u: unknown): Failure => {
  if (isOptiError(u)) {
    const base: Failure = { tag: u._tag, message: u.message, retry: u.retry };
    return u.action === undefined ? base : { ...base, action: u.action };
  }
  if (u instanceof Error) {
    return { tag: "Unexpected", message: u.message, retry: "never" };
  }
  return { tag: "Unexpected", message: String(u), retry: "never" };
};
