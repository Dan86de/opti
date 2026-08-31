/**
 * The response envelope.
 *
 * Every response leaves in this shape, so success and failure are the same
 * shape to parse. Kernel: no dependencies except the error taxonomy.
 */
import { Cause, Exit } from "effect";
import { type Failure, toFailure } from "./Failure.ts";

export type Envelope<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: Failure };

export const succeed = <A>(value: A): Envelope<A> => ({ ok: true, value });

export const fail = (error: Failure): Envelope<never> => ({ ok: false, error });

/**
 * Encode the result of a run into the envelope.
 *
 * `Cause.squash` reduces a cause to the original error or defect, which is
 * exactly what `toFailure` needs to recover a tag from. A failure therefore
 * arrives with its tag intact whether it was modelled or an uncaught throw -
 * the boundary does not flatten what went wrong.
 */
export const fromExit = <A, E>(exit: Exit.Exit<A, E>): Envelope<A> =>
  Exit.isSuccess(exit) ? succeed(exit.value) : fail(toFailure(Cause.squash(exit.cause)));
