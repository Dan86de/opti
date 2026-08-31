/**
 * The package state module of the owner store: source files, the manifest, a
 * staged published pointer, and the publish commit.
 *
 * Working state and live state are different things. The `package_files`
 * table and the manifest column are working state, mutated by create and
 * edit; the `published` column is a self-contained snapshot - manifest,
 * entry, emitted files - and only it ever enters an isolate. Publish is the
 * one transaction this module owns: the commit re-checks the revision the
 * checks ran against, so an edit that landed mid-publish fails the publish
 * rather than shipping unchecked code, and a failed commit leaves the
 * previous version serving.
 *
 * There is no version history, per the contract: a mutable published pointer
 * plus republish covers more than it appears to, and a version is close to
 * impossible to remove once anything depends on one.
 */
import { emittedPath, entryFile, type Manifest, type PackageFile } from "../packages/Manifest.ts";

/** Working state relative to the published pointer, for `read`'s overview:
 * a draft has never been published; modified has edits the published
 * snapshot does not carry. */
export type PackageState = "draft" | "published" | "modified";

export interface PackageOverview {
  readonly name: string;
  readonly state: PackageState;
  readonly summary: string;
  readonly updatedAt: string;
}

export interface PackageDetail {
  readonly name: string;
  readonly state: PackageState;
  readonly manifest: Manifest;
  readonly files: readonly PackageFile[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly published?: {
    readonly publishedAt: string;
    readonly revision: number;
    readonly entry: string;
  };
}

/** The published snapshot: everything an isolate or `search` needs, with no
 * reads back into working state. */
export interface PublishedSnapshot {
  readonly manifest: Manifest;
  /** The emitted entry file, `index.js`. */
  readonly entry: string;
  /** Emitted JavaScript by path. */
  readonly files: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly publishedAt: string;
}

export interface PublishedPackage extends PublishedSnapshot {
  readonly name: string;
}

/** What the publish checks run against, pinned to a revision so the commit
 * can tell whether an edit landed while they ran. */
export interface PublishSource {
  readonly manifest: Manifest;
  readonly files: readonly PackageFile[];
  readonly revision: number;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly message: string };

const refuse = (message: string): Verdict => ({ ok: false, message });

export const createTables = (sql: SqlStorage): void => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS packages (" +
      "name TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, " +
      "revision INTEGER NOT NULL, manifest TEXT NOT NULL, published TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS package_files (" +
      "name TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (name, path))",
  );
};

// A type alias rather than an interface: anonymous object types get the
// implicit index signature `exec<T>`'s constraint asks for.
type PackageRow = {
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
  readonly manifest: string;
  readonly published: string | null;
};

const rowFor = (sql: SqlStorage, name: string): PackageRow | undefined =>
  sql.exec<PackageRow>("SELECT * FROM packages WHERE name = ?", name).toArray()[0];

const filesFor = (sql: SqlStorage, name: string): PackageFile[] =>
  sql
    .exec<{ path: string; content: string }>(
      "SELECT path, content FROM package_files WHERE name = ? ORDER BY path",
      name,
    )
    .toArray();

const stateOf = (row: PackageRow): PackageState => {
  if (row.published === null) {
    return "draft";
  }
  const snapshot = JSON.parse(row.published) as PublishedSnapshot;
  return snapshot.revision === row.revision ? "published" : "modified";
};

/** The uniqueness this module can see is its own table; uniqueness against
 * capability names is checked at the tool, where the registry is known. */
export const create = (
  sql: SqlStorage,
  name: string,
  manifest: Manifest,
  files: readonly PackageFile[],
  now: Date,
): Verdict => {
  if (rowFor(sql, name) !== undefined) {
    return refuse(`a package named ${JSON.stringify(name)} already exists; edit it, or pick another name`);
  }
  const timestamp = now.toISOString();
  sql.exec(
    "INSERT INTO packages (name, created_at, updated_at, revision, manifest, published) VALUES (?, ?, ?, 1, ?, NULL)",
    name,
    timestamp,
    timestamp,
    JSON.stringify(manifest),
  );
  for (const file of files) {
    sql.exec("INSERT INTO package_files (name, path, content) VALUES (?, ?, ?)", name, file.path, file.content);
  }
  return { ok: true };
};

/** Everything with its state, so an unpublished draft from a dead
 * conversation is findable even though `search` will never show it. */
export const overview = (sql: SqlStorage): readonly PackageOverview[] =>
  sql
    .exec<PackageRow>("SELECT * FROM packages ORDER BY name")
    .toArray()
    .map((row) => ({
      name: row.name,
      state: stateOf(row),
      summary: (JSON.parse(row.manifest) as Manifest).summary,
      updatedAt: row.updated_at,
    }));

export const read = (sql: SqlStorage, name: string): PackageDetail | null => {
  const row = rowFor(sql, name);
  if (row === undefined) {
    return null;
  }
  const published = row.published === null ? null : (JSON.parse(row.published) as PublishedSnapshot);
  return {
    name: row.name,
    state: stateOf(row),
    manifest: JSON.parse(row.manifest) as Manifest,
    files: filesFor(sql, name),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(published === null
      ? {}
      : { published: { publishedAt: published.publishedAt, revision: published.revision, entry: published.entry } }),
  };
};

const touch = (sql: SqlStorage, name: string, now: Date): void => {
  sql.exec("UPDATE packages SET revision = revision + 1, updated_at = ? WHERE name = ?", now.toISOString(), name);
};

/** One call, one file. Writing a path that does not exist yet creates it,
 * because adding a file to a package is the same small change. */
export const editFile = (sql: SqlStorage, name: string, file: PackageFile, now: Date): Verdict => {
  if (rowFor(sql, name) === undefined) {
    return refuse(`no package is named ${JSON.stringify(name)}`);
  }
  sql.exec(
    "INSERT INTO package_files (name, path, content) VALUES (?, ?, ?) " +
      "ON CONFLICT(name, path) DO UPDATE SET content = ?",
    name,
    file.path,
    file.content,
    file.content,
  );
  touch(sql, name, now);
  return { ok: true };
};

/** Manifest changes ride the same action as file edits: whichever halves
 * arrive replace their half, and an absent half keeps what is there. */
export const editManifest = (sql: SqlStorage, name: string, changes: Partial<Manifest>, now: Date): Verdict => {
  const row = rowFor(sql, name);
  if (row === undefined) {
    return refuse(`no package is named ${JSON.stringify(name)}`);
  }
  const current = JSON.parse(row.manifest) as Manifest;
  const next: Manifest = {
    summary: changes.summary ?? current.summary,
    exports: changes.exports ?? current.exports,
  };
  sql.exec("UPDATE packages SET manifest = ? WHERE name = ?", JSON.stringify(next), name);
  touch(sql, name, now);
  return { ok: true };
};

export const publishSource = (sql: SqlStorage, name: string): PublishSource | null => {
  const row = rowFor(sql, name);
  if (row === undefined) {
    return null;
  }
  return {
    manifest: JSON.parse(row.manifest) as Manifest,
    files: filesFor(sql, name),
    revision: row.revision,
  };
};

/**
 * The commit half of the publish transaction. The checks ran outside against
 * a pinned revision; this refuses to move the pointer when working state
 * moved on, because publishing code the checks never saw is exactly what the
 * pipeline exists to prevent. On refusal the previous version keeps serving.
 */
export const commitPublish = (
  sql: SqlStorage,
  name: string,
  checkedRevision: number,
  emitted: Readonly<Record<string, string>>,
  now: Date,
): Verdict => {
  const row = rowFor(sql, name);
  if (row === undefined) {
    return refuse(`no package is named ${JSON.stringify(name)}`);
  }
  if (row.revision !== checkedRevision) {
    return refuse(`${JSON.stringify(name)} was edited while the publish checks ran; publish again`);
  }
  const manifest = JSON.parse(row.manifest) as Manifest;
  const entry = entryFile(filesFor(sql, name).map((file) => file.path));
  if (entry === null) {
    return refuse(`${JSON.stringify(name)} has no index file`);
  }
  const snapshot: PublishedSnapshot = {
    manifest,
    entry: emittedPath(entry),
    files: emitted,
    revision: row.revision,
    publishedAt: now.toISOString(),
  };
  sql.exec("UPDATE packages SET published = ? WHERE name = ?", JSON.stringify(snapshot), name);
  return { ok: true };
};

/** Every published snapshot, for `search` and for the module map. Working
 * state never appears here: publish is what makes a thing discoverable. */
export const listPublished = (sql: SqlStorage): readonly PublishedPackage[] =>
  sql
    .exec<PackageRow>("SELECT * FROM packages WHERE published IS NOT NULL ORDER BY name")
    .toArray()
    .flatMap((row) =>
      row.published === null ? [] : [{ name: row.name, ...(JSON.parse(row.published) as PublishedSnapshot) }],
    );
