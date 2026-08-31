/**
 * The `storage` capability, driven through the MCP surface the way a model
 * drives it: sandbox code importing from `opti:capabilities`, the call
 * leaving the isolate through the gateway, and the gateway routing the
 * reserved hostname to the owner's store instead of the network.
 *
 * The negative assertions carry the most: the other owner's value that was
 * not readable, the oversized value that was not stored, the sixth call the
 * budget did not allow.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { storageCapability } from "../../src/registry/Registry.ts";
import { storeFor } from "../../src/store/OwnerStore.ts";
import { VALUE_CEILING_BYTES } from "../../src/store/StorageData.ts";
import { callTool } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

describe("the storage capability", () => {
  it("runs the worked example search hands out, and gets its answer", async () => {
    // Imported from the registry, not copied: the live-fixture rule, so the
    // code a model copies most literally cannot go stale without failing.
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, storageCapability.example.code);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: storageCapability.example.result } });
  });

  it("keeps a value across runs: the loop's whole point", async () => {
    const { accessToken } = await mintAccessToken();

    await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => storage.set("todo:cursor", { page: 3 });`,
    );
    const later = await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => storage.get("todo:cursor");`,
    );

    // A fresh isolate per run means this value can only have come through
    // the store: nothing else survives between the two runs.
    expect(later.structuredContent).toMatchObject({ ok: true, value: { result: { page: 3 } } });
  });

  it("scopes storage to the owner, like everything else", async () => {
    const first = await mintAccessToken();
    const second = await mintAccessToken();

    await execute(
      first.accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => storage.set("shared-looking-key", "mine");`,
    );
    const theirs = await execute(
      second.accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => storage.get("shared-looking-key");`,
    );

    expect(theirs.structuredContent).toMatchObject({ ok: true, value: { result: null } });
  });

  it("refuses a key the charset cannot spell, as a typed throw", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => storage.set("No Spaces Allowed", 1);`,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "InvalidStorageKey", retry: "never" },
    });
  });

  it("fails an oversized set outright, and stores nothing", async () => {
    const { accessToken, ownerId } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => {
         try {
           await storage.set("blob", "x".repeat(${VALUE_CEILING_BYTES + 100}));
           return "stored";
         } catch (refusal) {
           return { stopped: refusal._tag, retry: refusal.retry };
         }
       };`,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { result: { stopped: "StorageValueTooLarge", retry: "never" } },
    });
    // The half that matters: never truncated also means never stored.
    expect(await storeFor(env.OWNER_STORE, ownerId).storageGet("blob")).toBeNull();
  });

  it("counts storage calls against the outbound fetch budget", async () => {
    // The test config pins FETCH_BUDGET to 4: a storage call is an outbound
    // request at the gateway's door, so the fifth one dies of the same
    // ceiling a fetch loop would - no third ceiling class exists.
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => {
         for (let i = 0; i < 10; i++) await storage.set("k:" + i, i);
         return "unbounded";
       };`,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "FetchBudgetExhausted", retry: "after" },
    });
  });
});
