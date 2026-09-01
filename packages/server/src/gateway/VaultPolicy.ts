/**
 * The vault write boundary: which vault paths sandbox code may write.
 *
 * The caller of every vault verb is model-written code, so the policy is
 * enforced here at the gateway - the choke point - and never left as a
 * convention in capability code. Reads are vault-wide; writes are confined to
 * a config-borne prefix list (`VAULT_WRITE_PREFIXES`), deny by default: an
 * empty list refuses every write, and widening it is a deliberate config
 * change, the same pattern as the credential host allowlist.
 *
 * Normalization runs before the prefix check on purpose: a traversal that
 * re-enters an allowed folder is still a traversal, and the boundary must see
 * the path the filesystem would.
 *
 * Pure module, like Denial.ts: unit tests reach it without workerd.
 */
import { Data } from "effect";
import type { Failure } from "../kernel/index.ts";

/** A vault path the route cannot accept: empty, absolute, or traversing. */
export class InvalidVaultPath extends Data.TaggedError("InvalidVaultPath")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** A write outside the approved folders. The message names what is allowed,
 * so the agent stops and writes elsewhere instead of retrying. */
export class VaultWriteRefused extends Data.TaggedError("VaultWriteRefused")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** A read of a note that is not there. */
export class NoSuchNote extends Data.TaggedError("NoSuchNote")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The vault container did not answer usefully. Retry `after`: the container
 * may be waking, and waking ends. */
export class VaultUnavailable extends Data.TaggedError("VaultUnavailable")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "after";
}

/**
 * A vault-relative path, exactly as Obsidian spells it: forward slashes,
 * spaces allowed, no leading slash, no empty or dot segments. Returns the
 * joined normal form, or the refusal.
 */
export const normalizePath = (path: unknown): string | InvalidVaultPath => {
  if (typeof path !== "string" || path.length === 0) {
    return new InvalidVaultPath({ message: "a vault path is a non-empty vault-relative string" });
  }
  // Spaces are ordinary in vault paths ("10 Content Engine"); backslashes
  // and control characters are not paths, they are games.
  const hasControlCharacter = [...path].some((character) => character.charCodeAt(0) < 0x20);
  if (path.includes("\\") || hasControlCharacter) {
    return new InvalidVaultPath({ message: "a vault path uses forward slashes and no control characters" });
  }
  if (path.startsWith("/")) {
    return new InvalidVaultPath({
      message: `a vault path is relative to the vault root; ${JSON.stringify(path)} starts with "/"`,
    });
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return new InvalidVaultPath({
      message: `${JSON.stringify(path)} contains empty or dot segments; spell the path from the vault root`,
    });
  }
  return segments.join("/");
};

/** The config-borne prefix list, comma-separated; blank entries dropped. */
export const parseWritePrefixes = (configured: string): readonly string[] =>
  configured
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);

/**
 * The write check, on a path already normalized. A prefix names a folder, so
 * the match is segment-aware: `10 Content Engine/` allows notes under that
 * folder and never a sibling that merely shares the spelling.
 */
export const checkWrite = (configured: string, normalized: string): VaultWriteRefused | null => {
  const prefixes = parseWritePrefixes(configured);
  const allowed = prefixes.some((prefix) => {
    const folder = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return normalized.startsWith(folder);
  });
  if (allowed) {
    return null;
  }
  return new VaultWriteRefused({
    message:
      prefixes.length === 0
        ? "no vault folder is approved for writes; writes are refused until the owner configures one"
        : `sandbox writes are confined to ${prefixes.map((prefix) => JSON.stringify(prefix)).join(", ")}; ` +
          `${JSON.stringify(normalized)} is outside them. Reads are unrestricted.`,
  });
};
