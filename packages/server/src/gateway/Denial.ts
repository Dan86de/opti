/**
 * How a gateway denial travels back into the sandbox.
 *
 * `globalOutbound` is a fetch seam, so the only vehicle a denial has is a
 * `Response`. A synthetic response marked `x-opti-failure: 1` carries the full
 * failure in its body - tag, message, retry, action - and the `fetch` export
 * in `opti:capabilities` checks the marker and throws the tagged error, which
 * is what turns a denial into a throw the entry module already knows how to
 * catch. Raw global `fetch` still sees the marked response; the wrapper is a
 * convenience, not the boundary.
 *
 * Pure module: the marker, the failure classes and the response builder, so
 * unit tests reach them without importing `cloudflare:workers`.
 */
import { Data } from "effect";
import { Failure } from "../kernel/index.ts";

export const FAILURE_HEADER = "x-opti-failure";

/**
 * The sandbox asked the gateway to call the worker it is running inside.
 * Refused as a class rather than trusted case by case: the admin token check
 * would hold, but sandboxed code has no business probing the admin routes or
 * looping back into `/mcp`, and refusing the class is cheaper than trusting
 * the case.
 */
export class OwnOriginRefused extends Data.TaggedError("OwnOriginRefused")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * A placeholder names a credential nobody saved. Distinct from
 * `HostNotApproved` because the fixes are different - save a credential
 * versus approve a host - and only approval has a link; saving is
 * terminal-only, so the message hands over the command instead.
 */
export class UnknownCredential extends Data.TaggedError("UnknownCredential")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The one denial a human can lift, so the one that carries an action. */
export class HostNotApproved extends Data.TaggedError("HostNotApproved")<{
  readonly message: string;
  readonly action: Failure.Action;
}> {
  readonly retry: Failure.Retry = "never";
}

/** A placeholder-bearing request that is not https on the default port,
 * whatever the allowlist says. */
export class InsecureTransport extends Data.TaggedError("InsecureTransport")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The daily outbound ceiling. Retry `after`: the message names the reset. */
export class FetchBudgetExhausted extends Data.TaggedError("FetchBudgetExhausted")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "after";
}

/**
 * Encode a denial as the marked synthetic response.
 *
 * The status is cosmetic - the wrapper dispatches on the marker, never the
 * status - but it is set honestly anyway for whoever reads a raw response.
 */
export const denialResponse = (error: Failure.OptiError, status: number): Response =>
  new Response(JSON.stringify(Failure.toFailure(error)), {
    status,
    headers: { "content-type": "application/json", [FAILURE_HEADER]: "1" },
  });
