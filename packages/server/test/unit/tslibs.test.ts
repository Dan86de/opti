/**
 * The embedded lib chain is generated from the pinned in-worker compiler,
 * and this is what pins it: an upgrade of the alias dependency fails here
 * until scripts/generate-tslibs.mjs is re-run, so the compiler and the libs
 * it checks against can never drift apart silently.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIB_FILES, LIB_VERSION } from "../../src/publish/libs.generated.ts";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("in-worker-typescript/package.json"));
const libDir = join(packageRoot, "lib");

/** The same roots the publish compile declares in Compile.ts. */
const ROOT_LIBS = ["lib.es2023.d.ts", "lib.webworker.d.ts"];

const REFERENCE = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g;

const closure = (): Map<string, string> => {
  const files = new Map<string, string>();
  const queue = [...ROOT_LIBS];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || files.has(name)) {
      continue;
    }
    const content = readFileSync(join(libDir, name), "utf8");
    files.set(name, content);
    for (const match of content.matchAll(REFERENCE)) {
      queue.push(`lib.${match[1]}.d.ts`);
    }
  }
  return files;
};

describe("the embedded lib chain", () => {
  it("matches the installed compiler's own libs, file for file", () => {
    const installed = closure();

    expect(LIB_VERSION).toBe(
      (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version,
    );
    expect(Object.keys(LIB_FILES).sort()).toStrictEqual([...installed.keys()].sort());
    for (const [name, content] of installed) {
      expect(LIB_FILES[name], `${name} drifted; re-run scripts/generate-tslibs.mjs`).toBe(content);
    }
  });
});
