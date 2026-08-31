/**
 * The virtual module builder is pure - a capability set and a submitted
 * module in, a module map out - so the grant-list property is proved here
 * without booting an isolate: the generated module exposes exactly the
 * resolved capability set and nothing else.
 */
import { describe, expect, it } from "vitest";
import { add } from "../../src/registry/Registry.ts";
import { build, CAPABILITIES_MODULE } from "../../src/runner/VirtualModule.ts";

const capabilitiesSource = (map: ReturnType<typeof build>): string => {
  const entry = map[CAPABILITIES_MODULE];
  return typeof entry === "string" ? entry : (entry?.js ?? "");
};

describe("the module map", () => {
  it("holds exactly the entry, the submitted module, and the grant list", async () => {
    const map = build([add], "export default async () => 1;");

    expect(Object.keys(map).sort()).toStrictEqual([CAPABILITIES_MODULE, "main.js", "submitted.js"].sort());
    expect(map["submitted.js"]).toBe("export default async () => 1;");
  });

  it("grants exactly what was resolved and nothing else", async () => {
    const granted = build([add], "");
    const ungranted = build([], "");

    expect(capabilitiesSource(granted)).toContain("add");
    // The negative half is the property: an empty resolution produces a
    // module with nothing in it, not a module with a default set.
    expect(capabilitiesSource(ungranted)).not.toContain("add");
  });

  it("states the grant list's type, because its name is not a path", async () => {
    // The spike finding: a module name without an extension is rejected
    // unless the object form states the type. The greppable specifier
    // survives only as long as this stays `{ js }`.
    const map = build([add], "");

    expect(map[CAPABILITIES_MODULE]).toStrictEqual({ js: add.code });
  });
});
