/**
 * Host policy: which hosts a given credential may reach.
 *
 * A separate module from the credential store rather than a flag on it,
 * because the unreachability of the write path from the capability layer is
 * the security property itself: `approve` is exported to the vault's admin
 * surface and to nothing else, and the import-boundary test is what holds
 * that line.
 *
 * The allowlist starts empty and denies by default. An entry is an exact
 * hostname, stored lowercased; the matching rules live in `gateway/Hosts.ts`
 * because matching happens where requests are, not where policy is stored.
 */
import { Effect } from "effect";

const key = (credential: string) => `hosts:${credential}`;

/** The hosts approved for one credential. Absent means none: deny is the
 * starting state and stays the state until the operator says otherwise. */
export const approvedHosts = (storage: DurableObjectStorage, credential: string): Effect.Effect<readonly string[]> =>
  Effect.promise(async () => (await storage.get<readonly string[]>(key(credential))) ?? []);

/**
 * The write path. Idempotent, because the operator pasting a command twice
 * should not be an error worth reading.
 */
export const approve = (storage: DurableObjectStorage, credential: string, host: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const wanted = host.toLowerCase();
    const existing = (await storage.get<readonly string[]>(key(credential))) ?? [];
    if (!existing.includes(wanted)) {
      await storage.put(key(credential), [...existing, wanted]);
    }
  });
