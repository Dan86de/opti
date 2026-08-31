/**
 * The owner vault: one durable object per owner, addressed by the owner id.
 *
 * It holds the credential store, the host policy and the daily counters as
 * three modules with separate write paths; this class is the wiring, not the
 * logic. Isolation is structural - a per-owner object is the multi-user
 * shape, not a compromise on it - and the relational store, when its trigger
 * fires, arrives beside the vaults rather than replacing them.
 *
 * The owner id arrives as a method argument rather than being read back off
 * the object's name, because a durable object cannot reliably read its own
 * name from inside. Every caller holds a branded `OwnerId` resolved at the
 * door; the string type here is what survives the RPC boundary, which erases
 * brands anyway.
 *
 * This is the first durable object, which makes the deployment-split trigger
 * live: a deploy of the script that owns this class restarts these objects.
 * The vault keeps nothing in memory, so at one owner that is nearly free.
 */
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import * as Counters from "./Counters.ts";
import * as CredentialStore from "./CredentialStore.ts";
import * as HostPolicy from "./HostPolicy.ts";

export interface VaultBindings {
  /** The one secret every per-purpose key derives from. */
  readonly CREDENTIAL_KEY: string;
}

/** What `search` and the admin surface may know: names and hosts, never values. */
export interface CredentialMetadata {
  readonly name: string;
  readonly hosts: readonly string[];
}

/** Why one named credential could not be resolved for a host. The two reasons
 * are distinct failures upstream because their fixes are different: save a
 * credential versus approve a host. */
export interface UnresolvedCredential {
  readonly name: string;
  readonly reason: "unknown" | "not-approved";
}

export type Resolution =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly unresolved: readonly UnresolvedCredential[] };

/** The vault for one owner. The only way anything addresses one. */
export const vaultFor = (
  namespace: DurableObjectNamespace<OwnerVault>,
  ownerId: string,
): DurableObjectStub<OwnerVault> => namespace.get(namespace.idFromName(ownerId));

export class OwnerVault extends DurableObject<VaultBindings> {
  /**
   * The credential store's write path, reachable only through the admin
   * surface; see the import-boundary test.
   */
  putCredential(ownerId: string, name: string, value: string): Promise<void> {
    return Effect.runPromise(CredentialStore.put(this.ctx.storage, this.env.CREDENTIAL_KEY, ownerId, name, value));
  }

  /** The host policy's write path, under the same import boundary. */
  approveHost(credential: string, host: string): Promise<void> {
    return Effect.runPromise(HostPolicy.approve(this.ctx.storage, credential, host));
  }

  /** Names with their approved hosts, for `search` and for the operator. */
  listCredentials(): Promise<CredentialMetadata[]> {
    const storage = this.ctx.storage;
    return Effect.runPromise(
      Effect.gen(function* () {
        const names = yield* CredentialStore.listNames(storage);
        const entries: CredentialMetadata[] = [];
        for (const name of names) {
          entries.push({ name, hosts: yield* HostPolicy.approvedHosts(storage, name) });
        }
        return entries;
      }),
    );
  }

  /**
   * Scan already happened; this is policy, then materialization. Every named
   * credential must have the host approved before any value is decrypted, so
   * a refusal never has plaintext in flight, and the answer distinguishes
   * "save a credential" from "approve a host" because the fixes differ.
   */
  resolveForHost(ownerId: string, names: readonly string[], host: string): Promise<Resolution> {
    const storage = this.ctx.storage;
    const secret = this.env.CREDENTIAL_KEY;
    return Effect.runPromise(
      Effect.gen(function* () {
        const saved = yield* CredentialStore.listNames(storage);
        const unresolved: UnresolvedCredential[] = [];
        for (const name of names) {
          if (!saved.includes(name)) {
            unresolved.push({ name, reason: "unknown" });
          } else if (!(yield* HostPolicy.approvedHosts(storage, name)).includes(host.toLowerCase())) {
            unresolved.push({ name, reason: "not-approved" });
          }
        }
        if (unresolved.length > 0) {
          return { ok: false, unresolved } as const;
        }

        const values: Record<string, string> = {};
        for (const name of names) {
          const value = yield* CredentialStore.get(storage, secret, ownerId, name).pipe(Effect.orDie);
          if (value !== undefined) {
            values[name] = value;
          }
        }
        return { ok: true, values } as const;
      }),
    );
  }

  /**
   * Every value in the vault, for the redaction scan and nothing else.
   * Scanning all of the owner's values rather than tracking which ones a run
   * touched keeps redaction stateless. A row that refuses to decrypt is
   * skipped rather than fatal: redaction must not be the thing that breaks a
   * run, and a value we cannot read is a value we cannot leak.
   */
  allValues(ownerId: string): Promise<Record<string, string>> {
    const storage = this.ctx.storage;
    const secret = this.env.CREDENTIAL_KEY;
    return Effect.runPromise(
      Effect.gen(function* () {
        const values: Record<string, string> = {};
        for (const name of yield* CredentialStore.listNames(storage)) {
          const value = yield* CredentialStore.get(storage, secret, ownerId, name).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (value !== undefined) {
            values[name] = value;
          }
        }
        return values;
      }),
    );
  }

  countExecution(limit: number): Promise<Counters.BudgetState> {
    return Effect.runPromise(Counters.count(this.ctx.storage, "executions", limit, new Date()));
  }

  countFetch(limit: number): Promise<Counters.BudgetState> {
    return Effect.runPromise(Counters.count(this.ctx.storage, "fetches", limit, new Date()));
  }
}
