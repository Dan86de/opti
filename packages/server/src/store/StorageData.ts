/**
 * The storage module of the owner store: the rows behind the `storage`
 * capability. Key-value with JSON values, flat and owner-scoped - the
 * namespace is the owner's whole store, because per-package scoping is
 * unenforceable when every storage call leaves the same isolate through the
 * same Fetcher. The model prefixes its own keys, and a collision is confined
 * to the owner's own data.
 *
 * Values are stored and returned as serialized JSON text: the gateway already
 * holds the request body as text, so parsing here would only be re-encoding
 * on both sides of an RPC hop.
 */
import { Data } from "effect";
import type { Failure } from "../kernel/index.ts";

export const KEY_PATTERN = /^[a-z0-9:._-]+$/;

/**
 * The result ceiling's own asymmetry, applied to writes: an oversized `set`
 * is a failure and never a truncation, because a store that quietly accepts
 * blobs becomes a blob store.
 */
export const VALUE_CEILING_BYTES = 32_768;

/** `list` is bounded, and a cut list carries a truncation marker. */
export const LIST_BOUND = 100;

export class InvalidStorageKey extends Data.TaggedError("InvalidStorageKey")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export class StorageValueTooLarge extends Data.TaggedError("StorageValueTooLarge")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export const checkKey = (key: string): InvalidStorageKey | null =>
  KEY_PATTERN.test(key)
    ? null
    : new InvalidStorageKey({ message: `a storage key matches [a-z0-9:._-]+; ${JSON.stringify(key)} does not` });

export const checkValueSize = (valueJson: string): StorageValueTooLarge | null =>
  valueJson.length <= VALUE_CEILING_BYTES
    ? null
    : new StorageValueTooLarge({
        message:
          `the value is ${valueJson.length} bytes serialized and the ceiling is ${VALUE_CEILING_BYTES}. ` +
          "It was not stored, and it was not truncated: store less, or split it across keys.",
      });

export const createTables = (sql: SqlStorage): void => {
  sql.exec("CREATE TABLE IF NOT EXISTS storage_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
};

/** The stored JSON text, or null for a key that was never set. */
export const get = (sql: SqlStorage, key: string): string | null => {
  const rows = sql.exec<{ value: string }>("SELECT value FROM storage_data WHERE key = ?", key).toArray();
  return rows[0]?.value ?? null;
};

export const set = (sql: SqlStorage, key: string, valueJson: string): void => {
  sql.exec(
    "INSERT INTO storage_data (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    key,
    valueJson,
    valueJson,
  );
};

export const remove = (sql: SqlStorage, key: string): boolean => {
  const existed = get(sql, key) !== null;
  sql.exec("DELETE FROM storage_data WHERE key = ?", key);
  return existed;
};

export interface StorageList {
  readonly keys: readonly string[];
  /** Present only when the list was cut, per the truncation discipline. */
  readonly truncated?: string;
}

/**
 * Keys under a prefix, ordered, bounded. The upper bound is the prefix plus
 * DEL (0x7f): every character a key may contain sorts below it, so the range
 * scan is exact without LIKE's wildcard rules, where `_` in a prefix would
 * silently match anything.
 */
export const list = (sql: SqlStorage, prefix: string): StorageList => {
  const rows = sql
    .exec<{ key: string }>(
      "SELECT key FROM storage_data WHERE key >= ? AND key < ? ORDER BY key LIMIT ?",
      prefix,
      `${prefix}\u007f`,
      LIST_BOUND + 1,
    )
    .toArray();
  if (rows.length <= LIST_BOUND) {
    return { keys: rows.map((row) => row.key) };
  }
  return {
    keys: rows.slice(0, LIST_BOUND).map((row) => row.key),
    truncated: `more keys exist under ${JSON.stringify(prefix)}; narrow the prefix`,
  };
};
