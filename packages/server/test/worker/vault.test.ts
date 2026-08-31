/**
 * The owner vault, driven through its RPC surface the way the gateway and the
 * admin routes drive it. The assertions worth the most are negative: the
 * value `list` did not return, the plaintext a wrong-host resolution never
 * materialized, the row that did not decrypt after being moved between
 * owners.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { vaultFor } from "../../src/vault/OwnerVault.ts";
import { mintedOwnerId } from "./support/token.ts";

describe("the credential store", () => {
  it("lists names and hosts, never values", async () => {
    const ownerId = mintedOwnerId();
    const vault = vaultFor(env.OWNER_VAULT, ownerId);

    await vault.putCredential(ownerId, "todoist", "todoist-secret-value");
    await vault.approveHost("todoist", "API.Todoist.com");

    const listed = await vault.listCredentials();

    expect(listed).toStrictEqual([{ name: "todoist", hosts: ["api.todoist.com"] }]);
    // The value that must not be present, asserted against the serialized
    // whole rather than a field somebody might rename.
    expect(JSON.stringify(listed)).not.toContain("todoist-secret-value");
  });

  it("refuses a name the placeholder protocol cannot spell", async () => {
    const ownerId = mintedOwnerId();
    const vault = vaultFor(env.OWNER_VAULT, ownerId);

    await expect(vault.putCredential(ownerId, "Todoist Token", "value")).rejects.toThrow(/\[a-z0-9._-\]/);
    expect(await vault.listCredentials()).toStrictEqual([]);
  });

  it("stores only ciphertext, asserted against the raw storage", async () => {
    const ownerId = mintedOwnerId();
    const vault = vaultFor(env.OWNER_VAULT, ownerId);
    await vault.putCredential(ownerId, "todoist", "todoist-secret-value");

    const raw = await runInDurableObject(vault, (_instance, state) => state.storage.get<string>("credential:todoist"));

    expect(raw).toMatch(/^v1\./);
    expect(raw).not.toContain("todoist-secret-value");
  });
});

describe("resolution", () => {
  it("resolves values only when every named credential has the host approved", async () => {
    const ownerId = mintedOwnerId();
    const vault = vaultFor(env.OWNER_VAULT, ownerId);
    await vault.putCredential(ownerId, "todoist", "todoist-secret-value");
    await vault.putCredential(ownerId, "other", "other-secret-value");
    await vault.approveHost("todoist", "api.todoist.com");

    // One of the two names lacks approval, so the whole request resolves to
    // a refusal and no value was decrypted for either.
    const denied = await vault.resolveForHost(ownerId, ["todoist", "other"], "api.todoist.com");
    expect(denied).toStrictEqual({ ok: false, unresolved: [{ name: "other", reason: "not-approved" }] });

    await vault.approveHost("other", "api.todoist.com");
    const resolved = await vault.resolveForHost(ownerId, ["todoist", "other"], "api.todoist.com");
    expect(resolved).toStrictEqual({
      ok: true,
      values: { todoist: "todoist-secret-value", other: "other-secret-value" },
    });
  });

  it("tells an unsaved credential apart from an unapproved host, because the fixes differ", async () => {
    const ownerId = mintedOwnerId();
    const vault = vaultFor(env.OWNER_VAULT, ownerId);
    await vault.putCredential(ownerId, "todoist", "todoist-secret-value");

    const resolution = await vault.resolveForHost(ownerId, ["todoist", "missing"], "api.todoist.com");

    expect(resolution).toStrictEqual({
      ok: false,
      unresolved: [
        // Story 24: the allowlist starts empty, so even the saved credential
        // reaches nothing until the operator says otherwise.
        { name: "todoist", reason: "not-approved" },
        { name: "missing", reason: "unknown" },
      ],
    });
  });
});

describe("the owner binding", () => {
  it("fails to decrypt a row copied into another owner's vault", async () => {
    const ownerA = mintedOwnerId();
    const ownerB = mintedOwnerId();
    const vaultA = vaultFor(env.OWNER_VAULT, ownerA);
    const vaultB = vaultFor(env.OWNER_VAULT, ownerB);
    await vaultA.putCredential(ownerA, "todoist", "todoist-secret-value");
    await vaultA.approveHost("todoist", "api.todoist.com");

    // The move itself: the ciphertext lands bit-for-bit in B's vault, with
    // B's approval in place, so decryption is the only thing left to refuse.
    const row = await runInDurableObject(vaultA, (_instance, state) => state.storage.get<string>("credential:todoist"));
    await runInDurableObject(vaultB, async (_instance, state) => {
      await state.storage.put("credential:todoist", row);
    });
    await vaultB.approveHost("todoist", "api.todoist.com");

    await expect(vaultB.resolveForHost(ownerB, ["todoist"], "api.todoist.com")).rejects.toThrow();
    // The redaction read skips the unreadable row rather than failing, and
    // above all it does not hand B the value: a value we cannot read is a
    // value we cannot leak.
    expect(await vaultB.allValues(ownerB)).toStrictEqual({});
  });
});

describe("the counters", () => {
  it("exhausts the execution budget at the limit and names the reset", async () => {
    const vault = vaultFor(env.OWNER_VAULT, mintedOwnerId());

    expect((await vault.countExecution(2)).exhausted).toBe(false);
    expect((await vault.countExecution(2)).exhausted).toBe(false);

    const third = await vault.countExecution(2);
    expect(third.exhausted).toBe(true);
    // The next UTC midnight, so the failure message can say when to retry.
    expect(third.resetsAt).toMatch(/T00:00:00\.000Z$/);
    expect(Date.parse(third.resetsAt)).toBeGreaterThan(Date.now());
  });

  it("counts executions and fetches on separate budgets", async () => {
    const vault = vaultFor(env.OWNER_VAULT, mintedOwnerId());
    await vault.countExecution(1);
    expect((await vault.countExecution(1)).exhausted).toBe(true);

    // The fetch bucket is untouched by the burned execution bucket.
    expect((await vault.countFetch(1)).exhausted).toBe(false);
  });
});
