/**
 * The first tests in the repository, so they are also the prior art.
 *
 * Convention, set deliberately here: a negative assertion names what must not
 * have happened, so a later reader sees the invariant rather than inferring it.
 */
import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Envelope from "../../src/kernel/Envelope.ts";
import * as Failure from "../../src/kernel/Failure.ts";

class Denied extends Data.TaggedError("Denied")<{ readonly message: string }> {
  readonly retry: Failure.Retry = "never";
  readonly action = { kind: "approve", url: "https://example.invalid/approve" };
}

describe("Envelope", () => {
  it("carries a success value", () => {
    const envelope = Envelope.fromExit(Effect.runSyncExit(Effect.succeed(41 + 1)));

    expect(envelope).toStrictEqual({ ok: true, value: 42 });
  });

  it("does not put an error field on a success", () => {
    const envelope = Envelope.fromExit(Effect.runSyncExit(Effect.succeed("fine")));

    // An absent field means the boring default, so a present field is always a
    // signal. A success that carried an `error` key at all would break that.
    expect(envelope).not.toHaveProperty("error");
  });

  it("keeps the tag of a modelled failure", () => {
    const envelope = Envelope.fromExit(Effect.runSyncExit(new Denied({ message: "nope" })));

    expect(envelope).toStrictEqual({
      ok: false,
      error: {
        tag: "Denied",
        message: "nope",
        retry: "never",
        action: { kind: "approve", url: "https://example.invalid/approve" },
      },
    });
  });

  it("keeps the tag of an uncaught throw", () => {
    const thrown = Effect.sync((): never => {
      throw new Denied({ message: "thrown, not failed" });
    });

    const envelope = Envelope.fromExit(Effect.runSyncExit(thrown));

    // The boundary must not flatten what went wrong: a defect that knew its own
    // tag is not allowed to arrive as "Unexpected".
    expect(envelope).toMatchObject({ ok: false, error: { tag: "Denied" } });
  });

  it("does not invent an action for a failure that has none", () => {
    const envelope = Envelope.fromExit(Effect.runSyncExit(Effect.fail(new Failure.Unexpected({ message: "bare" }))));

    expect(envelope).toStrictEqual({
      ok: false,
      error: { tag: "Unexpected", message: "bare", retry: "never" },
    });
    // Not merely undefined - the key must be absent, or "a present field is a
    // signal" stops being true over the wire.
    expect(envelope.ok === false && "action" in envelope.error).toBe(false);
  });
});

describe("toFailure", () => {
  it("tags a value that carries no tag of its own as Unexpected", () => {
    expect(Failure.toFailure("just a string")).toStrictEqual({
      tag: "Unexpected",
      message: "just a string",
      retry: "never",
    });
  });

  it("does not treat a plain Error as retryable", () => {
    // A caller repeating an unmodelled failure is guessing, so nothing that
    // reached here by accident may be classified "now" or "after".
    expect(Failure.toFailure(new Error("boom")).retry).toBe("never");
  });
});
