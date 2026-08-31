/**
 * The cipher under the credential store, held to the invariant the AAD
 * exists for: a ciphertext moved into another owner's place fails to
 * decrypt. Pure logic - webcrypto is the same primitive in node and in
 * workerd, and nothing here touches storage.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/vault/CredentialStore.ts";

const SECRET = "test-credential-key-with-enough-entropy";

describe("the cipher", () => {
  it("round-trips a value for its owner", async () => {
    const stored = await Effect.runPromise(encrypt(SECRET, "own_a", "todoist-token-123"));

    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain("todoist-token-123");
    expect(await Effect.runPromise(decrypt(SECRET, "own_a", stored))).toBe("todoist-token-123");
  });

  it("fails to decrypt a row copied into another owner's place", async () => {
    // The named threat, and the reason the AAD binds the owner: the
    // ciphertext is bit-for-bit intact, only the owner asking changed.
    const stored = await Effect.runPromise(encrypt(SECRET, "own_a", "todoist-token-123"));

    const exit = await Effect.runPromiseExit(decrypt(SECRET, "own_b", stored));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("DecryptFailed");
    // The value that must not be present: the failure does not leak what it
    // was protecting.
    expect(JSON.stringify(exit)).not.toContain("todoist-token-123");
  });

  it("fails on a tampered ciphertext", async () => {
    const stored = await Effect.runPromise(encrypt(SECRET, "own_a", "todoist-token-123"));
    const tampered = stored.slice(0, -2) + (stored.endsWith("aa") ? "bb" : "aa");

    const exit = await Effect.runPromiseExit(decrypt(SECRET, "own_a", tampered));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("refuses a version it does not speak, by name", async () => {
    const exit = await Effect.runPromiseExit(decrypt(SECRET, "own_a", "v2.abc.def"));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("not a v1 ciphertext");
  });

  it("never emits the same ciphertext twice for one plaintext", async () => {
    // A random IV per encryption: equal rows must not reveal equal values.
    const first = await Effect.runPromise(encrypt(SECRET, "own_a", "same-value"));
    const second = await Effect.runPromise(encrypt(SECRET, "own_a", "same-value"));

    expect(first).not.toBe(second);
  });
});
