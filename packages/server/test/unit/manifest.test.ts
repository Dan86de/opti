/**
 * The pure rules of the package store: names, file paths, the manifest.
 * Everything here decides from the value alone; uniqueness against the
 * registry and against existing packages is the callers' half.
 */
import { describe, expect, it } from "vitest";
import {
  checkFiles,
  checkManifest,
  checkName,
  emittedPath,
  entryFile,
  type Manifest,
} from "../../src/packages/Manifest.ts";

const manifest = (overrides?: Partial<Manifest>): Manifest => ({
  summary: "Adds numbers.",
  exports: [{ name: "sum", signature: "sum(a: number, b: number): number" }],
  ...overrides,
});

describe("package names", () => {
  it("accepts the credential charset and nothing else", () => {
    expect(checkName("todoist")).toBeNull();
    expect(checkName("my-tools.v2_beta")).toBeNull();
    expect(checkName("Todoist")).not.toBeNull();
    expect(checkName("todo ist")).not.toBeNull();
    expect(checkName("")).not.toBeNull();
  });
});

describe("package files", () => {
  it("needs an index file for the bare import to land on", () => {
    expect(checkFiles([{ path: "index.ts", content: "" }])).toBeNull();
    expect(checkFiles([{ path: "index.js", content: "" }])).toBeNull();

    const missing = checkFiles([{ path: "util.ts", content: "" }]);
    expect(missing?.message).toContain("index");
  });

  it("refuses two index files, because the entry must be unambiguous", () => {
    const both = checkFiles([
      { path: "index.ts", content: "" },
      { path: "index.js", content: "" },
    ]);
    expect(both?.message).toContain("one index file");
  });

  it("refuses a path that could name anything outside the package", () => {
    for (const path of ["../escape.ts", "/absolute.ts", "dir/../up.ts", "no-extension", "shout.TS"]) {
      expect(
        checkFiles([
          { path, content: "" },
          { path: "index.ts", content: "" },
        ]),
        path,
      ).not.toBeNull();
    }
    expect(
      checkFiles([
        { path: "index.ts", content: "" },
        { path: "lib/util.v2.ts", content: "" },
      ]),
    ).toBeNull();
  });

  it("refuses a duplicate path", () => {
    const duplicated = checkFiles([
      { path: "index.ts", content: "a" },
      { path: "index.ts", content: "b" },
    ]);
    expect(duplicated?.message).toContain("twice");
  });
});

describe("the manifest", () => {
  it("accepts declared exports in member form, function or value", () => {
    expect(checkManifest(manifest())).toBeNull();
    expect(checkManifest(manifest({ exports: [{ name: "limit", signature: "limit: number" }] }))).toBeNull();
  });

  it("needs a summary, because that is the line search shows", () => {
    expect(checkManifest(manifest({ summary: "  " }))?.message).toContain("summary");
  });

  it("needs at least one export", () => {
    expect(checkManifest(manifest({ exports: [] }))?.message).toContain("at least one export");
  });

  it("refuses an export that cannot be spliced into an export statement", () => {
    expect(checkManifest(manifest({ exports: [{ name: "not a name", signature: "x: 1" }] }))?.message).toContain(
      "identifier",
    );
  });

  it("refuses a signature that does not start with its export's name", () => {
    // The signature becomes a member of the conformance object type publish
    // compiles, so a mismatched name would check somebody else's export.
    const wrong = checkManifest(manifest({ exports: [{ name: "sum", signature: "add(a: number): number" }] }));
    expect(wrong?.message).toContain("start with the export's own name");
  });

  it("refuses the same export declared twice", () => {
    const twice = checkManifest(
      manifest({
        exports: [
          { name: "sum", signature: "sum(): number" },
          { name: "sum", signature: "sum(): string" },
        ],
      }),
    );
    expect(twice?.message).toContain("twice");
  });
});

describe("emitted paths", () => {
  it("maps TypeScript to its emitted JavaScript and leaves JavaScript alone", () => {
    expect(emittedPath("index.ts")).toBe("index.js");
    expect(emittedPath("lib/util.ts")).toBe("lib/util.js");
    expect(emittedPath("run.js")).toBe("run.js");
  });

  it("prefers index.ts and falls back to index.js", () => {
    expect(entryFile(["run.js", "index.ts"])).toBe("index.ts");
    expect(entryFile(["index.js", "run.js"])).toBe("index.js");
    expect(entryFile(["run.js"])).toBeNull();
  });
});
