/**
 * The pure rules of the package store: names, file paths, and the manifest.
 *
 * A package name shares the credential charset, `[a-z0-9._-]+`, and is unique
 * across capabilities and packages, so no package can shadow `fetch` and a
 * name lookup never needs disambiguation. The uniqueness check against
 * capabilities lives at the tool, where the registry is known; this module
 * holds only what can be decided from the value alone.
 *
 * The manifest is what `search` shows and what publish holds the code to:
 * every export is declared with a TypeScript signature, and the signature is
 * later compiled against the real exports, which is what keeps search honest.
 */
import { Data } from "effect";
import type { Failure } from "../kernel/index.ts";

/** Same charset as a credential name, and for the same reason: it has to be
 * spellable inside an import specifier without escaping. */
export const NAME_PATTERN = /^[a-z0-9._-]+$/;

/**
 * A file path inside a package: lowercase, relative, ending in the language
 * the compiler accepts. No `..` and no leading slash, so a path can never
 * name anything outside its own package.
 */
const FILE_PATTERN = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.(?:ts|js)$/;

/** An export must be spliceable into `export { name } from ...`. */
const EXPORT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface PackageExport {
  readonly name: string;
  /**
   * A TypeScript signature starting with the export's own name, in member
   * form: `run(): Promise<unknown>` for a function, `limit: number` for a
   * value. Member form is what lets publish splice every signature into one
   * object type and check the real module against it.
   */
  readonly signature: string;
}

export interface Manifest {
  readonly summary: string;
  readonly exports: readonly PackageExport[];
}

export interface PackageFile {
  readonly path: string;
  readonly content: string;
}

export class InvalidPackage extends Data.TaggedError("InvalidPackage")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

const invalid = (message: string) => new InvalidPackage({ message });

export const checkName = (name: string): InvalidPackage | null =>
  NAME_PATTERN.test(name)
    ? null
    : invalid(`a package name matches [a-z0-9._-]+ so an import can spell it; ${JSON.stringify(name)} does not`);

/** The one file an import of the bare package name lands on. */
export const entryFile = (paths: readonly string[]): string | null =>
  paths.includes("index.ts") ? "index.ts" : paths.includes("index.js") ? "index.js" : null;

/** What a source path becomes once publish has emitted it. */
export const emittedPath = (path: string): string => path.replace(/\.ts$/, ".js");

export const checkFilePath = (path: string): InvalidPackage | null =>
  FILE_PATTERN.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..")
    ? null
    : invalid(`a package file path is relative, lowercase and ends in .ts or .js; ${JSON.stringify(path)} is not one`);

export const checkFiles = (files: readonly PackageFile[]): InvalidPackage | null => {
  if (files.length === 0) {
    return invalid("a package needs at least one file");
  }
  const seen = new Set<string>();
  for (const file of files) {
    const badPath = checkFilePath(file.path);
    if (badPath !== null) {
      return badPath;
    }
    if (seen.has(file.path)) {
      return invalid(`the path ${JSON.stringify(file.path)} appears twice`);
    }
    seen.add(file.path);
  }
  const paths = files.map((file) => file.path);
  if (entryFile(paths) === null) {
    return invalid("a package needs an index.ts or index.js: the file the bare package import lands on");
  }
  if (paths.includes("index.ts") && paths.includes("index.js")) {
    return invalid("a package has one index file, not both index.ts and index.js");
  }
  return null;
};

export const checkManifest = (manifest: Manifest): InvalidPackage | null => {
  if (manifest.summary.trim().length === 0) {
    return invalid("the manifest needs a summary: it is the line search shows for this package");
  }
  if (manifest.exports.length === 0) {
    return invalid("the manifest declares at least one export; a package exporting nothing is undiscoverable");
  }
  const seen = new Set<string>();
  for (const declared of manifest.exports) {
    if (!EXPORT_NAME_PATTERN.test(declared.name)) {
      return invalid(`an export name is a JavaScript identifier; ${JSON.stringify(declared.name)} is not one`);
    }
    if (seen.has(declared.name)) {
      return invalid(`the export ${JSON.stringify(declared.name)} is declared twice`);
    }
    seen.add(declared.name);
    // Member form is checked here so a publish failure points at the manifest
    // line, not at a compiler error inside a file nobody wrote.
    const member = declared.signature.trim();
    if (!(member.startsWith(`${declared.name}(`) || member.startsWith(`${declared.name}:`))) {
      return invalid(
        `the signature for ${JSON.stringify(declared.name)} must start with the export's own name, ` +
          `as \`${declared.name}(...): ...\` or \`${declared.name}: ...\``,
      );
    }
  }
  return null;
};
