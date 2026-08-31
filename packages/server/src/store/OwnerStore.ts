/**
 * The owner store: the second per-owner durable object, beside the vault.
 * SQLite-backed, holding run records, package state and storage data as three
 * modules with separate write paths - the vault's own pattern. This class is
 * the wiring, not the logic.
 *
 * A separate class from the vault on purpose: a durable object is
 * single-threaded, so record writes and mid-run storage calls must not
 * serialize with credential resolution - and sandbox-driven storage traffic
 * must not gain a call path into the object that holds credentials. The vault
 * stays the secrets object; this is the work object. One new class rather
 * than one per concern, because at one owner three migrations and three stubs
 * buy isolation nothing yet needs.
 *
 * Methods that a failure must cross as data answer with verdicts, like the
 * vault's: a rejection over the RPC boundary arrives stripped to a message
 * string, and the callers here need the refusal in an envelope.
 */
import { DurableObject } from "cloudflare:workers";
import type { Manifest, PackageFile } from "../packages/Manifest.ts";
import * as PackageState from "./PackageState.ts";
import * as RunRecords from "./RunRecords.ts";
import * as StorageData from "./StorageData.ts";

/** The record write's verdict. Never a throw: when the run succeeded and the
 * record write failed, the caller returns the run's real result with an
 * explicit no-record marker, and a throw would flatten that into a failure. */
export type PutRecordVerdict = { readonly written: true } | { readonly written: false; readonly message: string };

/** The store for one owner. The only way anything addresses one. */
export const storeFor = (
  namespace: DurableObjectNamespace<OwnerStore>,
  ownerId: string,
): DurableObjectStub<OwnerStore> => namespace.get(namespace.idFromName(ownerId));

export class OwnerStore extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Idempotent by construction, so a restart - which every deploy of this
    // script causes - needs no migration step beyond this.
    StorageData.createTables(ctx.storage.sql);
    RunRecords.createTables(ctx.storage.sql);
    PackageState.createTables(ctx.storage.sql);
  }

  // -- storage: the rows behind the `storage` capability -------------------

  /** The stored JSON text, or null. Text on purpose: the gateway holds the
   * request body as text, so value bytes cross this boundary unparsed. */
  storageGet(key: string): string | null {
    return StorageData.get(this.ctx.storage.sql, key);
  }

  storageSet(key: string, valueJson: string): void {
    StorageData.set(this.ctx.storage.sql, key, valueJson);
  }

  storageDelete(key: string): boolean {
    return StorageData.remove(this.ctx.storage.sql, key);
  }

  storageList(prefix: string): StorageData.StorageList {
    return StorageData.list(this.ctx.storage.sql, prefix);
  }

  // -- run records and the trail -------------------------------------------

  appendTrail(runId: string, line: RunRecords.TrailLine): void {
    RunRecords.appendTrail(this.ctx.storage.sql, runId, line, new Date());
  }

  putRecord(record: RunRecords.RunRecordInput): PutRecordVerdict {
    try {
      this.ctx.storage.transactionSync(() => {
        RunRecords.putRecord(this.ctx.storage.sql, record, new Date());
      });
      return { written: true };
    } catch (cause) {
      return { written: false, message: `the run record could not be written: ${String(cause)}` };
    }
  }

  queryRuns(filter: RunRecords.RunQuery): readonly RunRecords.RunSummary[] {
    return RunRecords.query(this.ctx.storage.sql, filter);
  }

  /** The record as JSON text, or null; see `RunRecords.get` for why text. */
  getRun(runId: string): string | null {
    return RunRecords.get(this.ctx.storage.sql, runId);
  }

  // -- packages -------------------------------------------------------------

  /** The package write paths below are reachable from the `packages` tool
   * and from nowhere else; the import-boundary test holds that line. */
  createPackage(name: string, manifest: Manifest, files: readonly PackageFile[]): PackageState.Verdict {
    return this.ctx.storage.transactionSync(() =>
      PackageState.create(this.ctx.storage.sql, name, manifest, files, new Date()),
    );
  }

  packagesOverview(): readonly PackageState.PackageOverview[] {
    return PackageState.overview(this.ctx.storage.sql);
  }

  readPackage(name: string): PackageState.PackageDetail | null {
    return PackageState.read(this.ctx.storage.sql, name);
  }

  editPackageFile(name: string, file: PackageFile): PackageState.Verdict {
    return this.ctx.storage.transactionSync(() => PackageState.editFile(this.ctx.storage.sql, name, file, new Date()));
  }

  editPackageManifest(name: string, changes: Partial<Manifest>): PackageState.Verdict {
    return this.ctx.storage.transactionSync(() =>
      PackageState.editManifest(this.ctx.storage.sql, name, changes, new Date()),
    );
  }

  publishSource(name: string): PackageState.PublishSource | null {
    return PackageState.publishSource(this.ctx.storage.sql, name);
  }

  commitPublish(
    name: string,
    checkedRevision: number,
    emitted: Readonly<Record<string, string>>,
  ): PackageState.Verdict {
    return this.ctx.storage.transactionSync(() =>
      PackageState.commitPublish(this.ctx.storage.sql, name, checkedRevision, emitted, new Date()),
    );
  }

  listPublished(): readonly PackageState.PublishedPackage[] {
    return PackageState.listPublished(this.ctx.storage.sql);
  }
}
