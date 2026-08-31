/**
 * The `packages` tool end to end, through the publish pipeline: typecheck and
 * emit with the in-worker compiler, boot in a real isolate, verify the
 * declared exports, and only then move the pointer.
 *
 * The first test is the slice's done-when in miniature: "that worked, save
 * it", and then a brand new conversation finding the package instead of
 * starting over. The negative assertions carry the most: the draft search
 * did not show, the failed publish that left the previous version serving,
 * the manifest signature the real code could not satisfy.
 */
import { describe, expect, it } from "vitest";
import { callTool } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });
const packages = (accessToken: string, args: unknown) => callTool(accessToken, "packages", args);
const search = (accessToken: string, args: unknown) => callTool(accessToken, "search", args);

const value = <T>(result: { structuredContent: unknown }): T => (result.structuredContent as { value: T }).value;

describe("the loop closes", () => {
  it("saves a run as a package, and a new conversation finds and runs it", async () => {
    const { accessToken } = await mintAccessToken();

    // The run that worked: it keeps state, so the package proves the whole
    // chain - storage through the gateway, from code imported as a package.
    const run = await execute(
      accessToken,
      `import { storage } from "opti:capabilities";
       export default async () => {
         const todos = (await storage.get("todos")) ?? ["write the spec"];
         await storage.set("todos", todos);
         return todos;
       };`,
    );
    expect(run.isError).toBeUndefined();
    const { runId } = value<{ runId: string }>(run);

    // "That worked, save it as todoist": one call, naming the run - the code
    // is never re-sent.
    const created = await packages(accessToken, {
      action: "create",
      name: "todoist",
      fromRun: runId,
      summary: "List my Todoist todos.",
    });
    expect(created.structuredContent).toMatchObject({ ok: true, value: { created: "todoist", state: "draft" } });

    // A draft is findable through read, and invisible to search: publish is
    // what makes a thing discoverable.
    const beforePublish = await search(accessToken, { query: "todos" });
    expect(JSON.stringify(value(beforePublish))).not.toContain('"todoist"');

    const published = await packages(accessToken, { action: "publish", name: "todoist" });
    expect(published.structuredContent).toMatchObject({
      ok: true,
      value: { published: "todoist", exports: ["run"] },
    });

    // The brand new conversation: a fresh token, asking "what are my todos".
    const found = await search(accessToken, { query: "my todos" });
    const results = value<{ results: { kind: string; name: string }[] }>(found).results;
    expect(results[0]).toMatchObject({ kind: "package", name: "todoist" });

    // And the import the search result names actually runs - two files, a
    // relative import between them, resolved inside the module map.
    const reused = await execute(
      accessToken,
      `import { run } from "opti:packages/todoist";
       export default async () => run();`,
    );
    expect(reused.structuredContent).toMatchObject({ ok: true, value: { result: ["write the spec"] } });
  }, 60_000);
});

describe("publish holds the line", () => {
  const sumFiles = [
    {
      path: "index.ts",
      content: "export const sum = (a: number, b: number): number => a + b;\n",
    },
  ];
  const sumExports = [{ name: "sum", signature: "sum(a: number, b: number): number" }];

  it("typechecks TypeScript source and serves the emitted JavaScript", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "sum",
      summary: "Adds numbers.",
      files: sumFiles,
      exports: sumExports,
    });
    const published = await packages(accessToken, { action: "publish", name: "sum" });
    expect(published.structuredContent).toMatchObject({ ok: true, value: { published: "sum" } });

    const used = await execute(
      accessToken,
      `import { sum } from "opti:packages/sum";
       export default async () => sum(20, 22);`,
    );
    expect(used.structuredContent).toMatchObject({ ok: true, value: { result: 42 } });
  }, 30_000);

  it("fails a publish whose code does not typecheck, naming the place", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "broken",
      summary: "Will not compile.",
      files: [{ path: "index.ts", content: 'export const sum: number = "not a number";\n' }],
      exports: [{ name: "sum", signature: "sum: number" }],
    });
    const published = await packages(accessToken, { action: "publish", name: "broken" });

    expect(published.isError).toBe(true);
    expect(published.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "PublishCheckFailed", retry: "never" },
    });
    const error = (published.structuredContent as { error: { message: string } }).error;
    expect(error.message).toContain("index.ts:1");
  }, 30_000);

  it("holds the code to the manifest's signature, because search must stay honest", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "dishonest",
      summary: "Claims a signature the code cannot satisfy.",
      files: [{ path: "index.ts", content: "export const shout = (word: string): string => word.toUpperCase();\n" }],
      // The declared parameter type is wrong on purpose: a number is not
      // assignable where the real function wants a string.
      exports: [{ name: "shout", signature: "shout(volume: number): string" }],
    });
    const published = await packages(accessToken, { action: "publish", name: "dishonest" });

    expect(published.isError).toBe(true);
    expect(published.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "PublishCheckFailed" },
    });
  }, 30_000);

  it("fails a publish whose declared export does not exist, at publish and not in somebody's run", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "hollow",
      summary: "Declares more than it has.",
      files: [{ path: "index.js", content: "export const real = 1;\n" }],
      exports: [
        { name: "real", signature: "real: number" },
        { name: "imaginary", signature: "imaginary: number" },
      ],
    });
    const published = await packages(accessToken, { action: "publish", name: "hollow" });

    expect(published.isError).toBe(true);
    const error = (published.structuredContent as { error: { message: string } }).error;
    expect(error.message).toContain("imaginary");
  }, 30_000);

  it("leaves the previous version serving when a later publish fails", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "sum",
      summary: "Adds numbers.",
      files: sumFiles,
      exports: sumExports,
    });
    await packages(accessToken, { action: "publish", name: "sum" });

    // The edit breaks the package; the publish check catches it.
    await packages(accessToken, {
      action: "edit",
      name: "sum",
      path: "index.ts",
      content: "export const nothing = 0;\n",
    });
    const failed = await packages(accessToken, { action: "publish", name: "sum" });
    expect(failed.isError).toBe(true);

    // The pointer did not move: a run still gets the last good version.
    const used = await execute(
      accessToken,
      `import { sum } from "opti:packages/sum";
       export default async () => sum(1, 2);`,
    );
    expect(used.structuredContent).toMatchObject({ ok: true, value: { result: 3 } });
    // And read says so: working state moved on, live state did not.
    const detail = await packages(accessToken, { action: "read", name: "sum" });
    expect(value<{ state: string }>(detail).state).toBe("modified");
  }, 30_000);

  it("lets one package import another by name, as ordinary code", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "sum",
      summary: "Adds numbers.",
      files: sumFiles,
      exports: sumExports,
    });
    await packages(accessToken, { action: "publish", name: "sum" });

    await packages(accessToken, {
      action: "create",
      name: "double",
      summary: "Doubles a number, standing on sum.",
      files: [
        {
          path: "index.ts",
          content:
            'import { sum } from "opti:packages/sum";\nexport const double = (n: number): number => sum(n, n);\n',
        },
      ],
      exports: [{ name: "double", signature: "double(n: number): number" }],
    });
    const published = await packages(accessToken, { action: "publish", name: "double" });
    expect(published.structuredContent).toMatchObject({ ok: true, value: { published: "double" } });

    const used = await execute(
      accessToken,
      `import { double } from "opti:packages/double";
       export default async () => double(21);`,
    );
    expect(used.structuredContent).toMatchObject({ ok: true, value: { result: 42 } });
  }, 30_000);
});

describe("names and lifecycle", () => {
  it("refuses a package named after a capability, so nothing can shadow fetch", async () => {
    const { accessToken } = await mintAccessToken();

    const created = await packages(accessToken, {
      action: "create",
      name: "fetch",
      summary: "A trap.",
      files: [{ path: "index.js", content: "export const run = 1;\n" }],
      exports: [{ name: "run", signature: "run: number" }],
    });

    expect(created.isError).toBe(true);
    expect(created.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "PackageNameTaken", retry: "never" },
    });
  });

  it("lists everything with its state, so a draft from a dead conversation is findable", async () => {
    const { accessToken } = await mintAccessToken();

    await packages(accessToken, {
      action: "create",
      name: "forgotten",
      summary: "A draft nobody published.",
      files: [{ path: "index.js", content: "export const later = 1;\n" }],
      exports: [{ name: "later", signature: "later: number" }],
    });

    const listed = await packages(accessToken, { action: "read" });

    expect(value<{ packages: unknown[] }>(listed).packages).toStrictEqual([
      { name: "forgotten", state: "draft", summary: "A draft nobody published.", updatedAt: expect.any(String) },
    ]);
  });

  it("refuses an edit that changes both a file and the manifest at once", async () => {
    const { accessToken } = await mintAccessToken();
    await packages(accessToken, {
      action: "create",
      name: "sum",
      summary: "Adds numbers.",
      files: [{ path: "index.js", content: "export const sum = (a, b) => a + b;\n" }],
      exports: [{ name: "sum", signature: "sum(a: number, b: number): number" }],
    });

    const edited = await packages(accessToken, {
      action: "edit",
      name: "sum",
      path: "index.js",
      content: "export const sum = () => 0;\n",
      summary: "Also new.",
    });

    expect(edited.isError).toBe(true);
    expect(edited.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "MalformedPackageRequest", retry: "never" },
    });
  });
});
