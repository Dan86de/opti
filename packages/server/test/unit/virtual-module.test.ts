/**
 * The virtual module builder is pure - a capability set, the published
 * packages and a submitted module in, a module map out - so the grant-list
 * property is proved here without booting an isolate: the generated module
 * exposes exactly the resolved set and nothing else.
 */
import { describe, expect, it } from "vitest";
import { add } from "../../src/registry/Registry.ts";
import { build, CAPABILITIES_MODULE, type SandboxPackage } from "../../src/runner/VirtualModule.ts";

const capabilitiesSource = (map: ReturnType<typeof build>): string => {
  const entry = map[CAPABILITIES_MODULE];
  return typeof entry === "string" ? entry : (entry?.js ?? "");
};

const moduleSource = (map: ReturnType<typeof build>, name: string): string => {
  const entry = map[name];
  return typeof entry === "string" ? entry : (entry?.js ?? "");
};

const todoist: SandboxPackage = {
  name: "todoist",
  entry: "index.js",
  files: { "index.js": 'export { default as run } from "./run.js";', "run.js": "export default async () => [];" },
  exportNames: ["run"],
};

describe("the module map", () => {
  it("holds exactly the entry, the submitted module, and the grant list", async () => {
    const map = build([add], [], "export default async () => 1;");

    expect(Object.keys(map).sort()).toStrictEqual([CAPABILITIES_MODULE, "main.js", "submitted.js"].sort());
    expect(map["submitted.js"]).toBe("export default async () => 1;");
  });

  it("grants exactly what was resolved and nothing else", async () => {
    const granted = build([add], [], "");
    const ungranted = build([], [], "");

    expect(capabilitiesSource(granted)).toContain("add");
    // The negative half is the property: an empty resolution produces a
    // module with nothing in it, not a module with a default set.
    expect(capabilitiesSource(ungranted)).not.toContain("add");
  });

  it("states the grant list's type, because its name is not a path", async () => {
    // The spike finding: a module name without an extension is rejected
    // unless the object form states the type. The greppable specifier
    // survives only as long as this stays `{ js }`.
    const map = build([add], [], "");

    expect(map[CAPABILITIES_MODULE]).toStrictEqual({ js: add.code });
  });
});

describe("packages in the map", () => {
  it("mounts each package's files and an alias carrying only the manifest's names", async () => {
    const map = build([add], [todoist], "");

    expect(moduleSource(map, "opti:packages/todoist/run.js")).toBe(todoist.files["run.js"]);
    // The alias is the manifest as an interface: exactly the declared names,
    // re-exported from the entry file. The leading slash is workerd's "from
    // the root", because this alias module's own name contains slashes.
    expect(moduleSource(map, "opti:packages/todoist")).toBe('export { run } from "/opti:packages/todoist/index.js";');
  });

  it("refuses to splice capability code that names opti:packages", async () => {
    // The layering rule at build time: a capability never imports a package,
    // because an edit to a package must never change what a primitive means.
    const poisoned = {
      ...add,
      code: 'import { run } from "opti:packages/todoist";\nexport const add = run;',
    };

    expect(() => build([poisoned], [], "")).toThrowError(/opti:packages/);
  });
});
