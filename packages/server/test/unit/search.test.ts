/**
 * Ranking and bounding are pure logic, so they are proved here with synthetic
 * capabilities. The registry holds one real capability today, which means the
 * bound and the ranking order cannot be exercised through the MCP surface -
 * this file is where those behaviours keep existing when nobody can see them.
 */
import { describe, expect, it } from "vitest";
import { slimList } from "../../src/discovery/Search.ts";
import type { Capability, PackageEntry } from "../../src/registry/Registry.ts";

const capability = (name: string, summary: string): Capability => ({
  kind: "capability",
  name,
  summary,
  signature: `${name}(): void`,
  importLine: `import { ${name} } from "opti:capabilities";`,
  errorTags: [],
  example: { code: "", result: null },
  code: "",
});

describe("ranking", () => {
  it("puts an exact name match above a summary mention", async () => {
    const entries = [capability("notify", "Send a message about totals."), capability("total", "Sum things up.")];

    const { results } = slimList(entries, "total");

    expect(results.map((entry) => entry.name)).toStrictEqual(["total", "notify"]);
  });

  it("drops entries that match nothing rather than ranking them last", async () => {
    const entries = [capability("add", "Add two numbers."), capability("greet", "Say hello.")];

    const { results } = slimList(entries, "add");

    expect(results.map((entry) => entry.name)).toStrictEqual(["add"]);
  });
});

describe("the package tie-break", () => {
  const pkg = (name: string, summary: string): PackageEntry => ({
    kind: "package",
    name,
    summary,
    exports: [{ name: "run", signature: "run(): Promise<unknown>" }],
    importLine: `import { run } from "opti:packages/${name}";`,
  });

  it("ranks a package above a capability when both match equally", async () => {
    // "When both match equally" is the whole rule: a tie-break, not a bonus.
    const entries = [capability("todo-sync", "Sync todos."), pkg("todo-list", "Sync todos.")];

    const { results } = slimList(entries, "todos");

    expect(results.map((entry) => entry.name)).toStrictEqual(["todo-list", "todo-sync"]);
  });

  it("does not let a weak package match outrank a strong primitive match", async () => {
    const entries = [pkg("helper", "Mentions adding in passing."), capability("add", "Add two numbers.")];

    const { results } = slimList(entries, "add");

    expect(results.map((entry) => entry.name)).toStrictEqual(["add", "helper"]);
  });

  it("puts packages first when nothing was asked, because everything ties at nothing", async () => {
    const entries = [capability("add", "Add two numbers."), pkg("todoist", "List my todos.")];

    const { results } = slimList(entries, undefined);

    expect(results.map((entry) => entry.name)).toStrictEqual(["todoist", "add"]);
  });
});

describe("bounding", () => {
  const many = Array.from({ length: 14 }, (_, index) => capability(`tool${index}`, "One of many tools."));

  it("cuts a long list and says so, naming how much was dropped", async () => {
    const response = slimList(many, "tools");

    expect(response.results).toHaveLength(10);
    // A silently cut list teaches a model the missing thing does not exist.
    expect(response.truncated).toContain("4 more");
  });

  it("carries no truncation marker when nothing was cut", async () => {
    const response = slimList(many.slice(0, 3), undefined);

    expect(response.results).toHaveLength(3);
    // An absent field means the boring default, so presence must stay a signal.
    expect(response.truncated).toBeUndefined();
  });
});
