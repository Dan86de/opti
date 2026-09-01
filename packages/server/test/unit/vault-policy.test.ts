/**
 * The vault write boundary, as pure logic: normalization before policy, deny
 * by default, and refusal messages that name what is allowed. The negative
 * assertions live in the worker test, where "the container was never
 * reached" can be read off the wire; here the policy itself is pinned.
 */
import { describe, expect, it } from "vitest";
import {
  checkWrite,
  InvalidVaultPath,
  normalizePath,
  parseWritePrefixes,
  VaultWriteRefused,
} from "../../src/gateway/VaultPolicy.ts";

describe("normalizePath", () => {
  it("accepts a vault path exactly as Obsidian spells it, spaces included", () => {
    expect(normalizePath("10 Content Engine/00 Index.md")).toBe("10 Content Engine/00 Index.md");
  });

  it("refuses traversal, absolute paths, dot segments and empty segments", () => {
    for (const path of ["../secrets", "a/../b", "/etc/passwd", "a//b", "./a", "a/./b", "", "a\\b", "a\u0000b"]) {
      expect(normalizePath(path), path).toBeInstanceOf(InvalidVaultPath);
    }
  });

  it("refuses a non-string without throwing", () => {
    expect(normalizePath(42)).toBeInstanceOf(InvalidVaultPath);
    expect(normalizePath(undefined)).toBeInstanceOf(InvalidVaultPath);
  });
});

describe("checkWrite", () => {
  it("allows a write under an approved folder", () => {
    expect(checkWrite("10 Content Engine/", "10 Content Engine/draft.md")).toBeNull();
    expect(checkWrite("10 Content Engine/", "10 Content Engine/videos/03.md")).toBeNull();
  });

  it("refuses everything when no prefix is configured, because deny is the default", () => {
    const refused = checkWrite("", "10 Content Engine/draft.md");
    expect(refused).toBeInstanceOf(VaultWriteRefused);
  });

  it("refuses the journal, and the message names what is allowed", () => {
    const refused = checkWrite("10 Content Engine/", "00 Journal/2026-09-01.md");
    expect(refused).toBeInstanceOf(VaultWriteRefused);
    expect(refused?.message).toContain('"10 Content Engine/"');
    // The value that must not be present: nothing in the refusal echoes the
    // journal's content, only its path.
    expect(refused?.retry).toBe("never");
  });

  it("matches folders segment-aware, so a sibling sharing the spelling stays refused", () => {
    // "10 Content Engineering/" starts with the same characters but is not
    // under the approved folder.
    expect(checkWrite("10 Content Engine", "10 Content Engineering/draft.md")).toBeInstanceOf(VaultWriteRefused);
    // A prefix configured without its trailing slash still means the folder.
    expect(checkWrite("10 Content Engine", "10 Content Engine/draft.md")).toBeNull();
  });

  it("refuses a write naming the folder itself rather than a note in it", () => {
    expect(checkWrite("10 Content Engine/", "10 Content Engine")).toBeInstanceOf(VaultWriteRefused);
  });

  it("parses the config shape: comma-separated, trimmed, blanks dropped", () => {
    expect(parseWritePrefixes(" 10 Content Engine/ , 90 Scratch ,, ")).toStrictEqual([
      "10 Content Engine/",
      "90 Scratch",
    ]);
    expect(parseWritePrefixes("")).toStrictEqual([]);
  });
});
