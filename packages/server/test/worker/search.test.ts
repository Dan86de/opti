/**
 * The `search` tool, driven through the MCP surface the way a model drives it.
 *
 * The decisions under test are about context budget: the call a model makes on
 * every turn must be the cheap one, so the slim response and the tools/list
 * response each have a 2KB ceiling, signatures arrive as TypeScript rather
 * than JSON Schema, and error tags appear in detail only.
 */
import { describe, expect, it } from "vitest";
import { callTool, rpc } from "./support/mcp.ts";
import { mintOwner, operator } from "./support/operator.ts";
import { mintAccessToken } from "./support/token.ts";

interface ToolsList {
  tools: { name: string; description: string; inputSchema: unknown }[];
}

const search = (accessToken: string, args: unknown) => callTool(accessToken, "search", args);

/** The ceiling is on what enters the model's context, byte-counted encoded. */
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("tools/list", () => {
  it("advertises search, and stays under the 2KB ceiling", async () => {
    const { accessToken } = await mintAccessToken();

    const listed = (await rpc(accessToken, "tools/list", {})) as ToolsList;

    expect(listed.tools.map((tool) => tool.name)).toContain("search");
    // Paid on every conversation whether or not OPTI is used.
    expect(bytes(listed)).toBeLessThanOrEqual(2048);
  });
});

describe("search", () => {
  it("returns everything ranked when asked for nothing in particular", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await search(accessToken, {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: {
        results: [
          { kind: "capability", name: "add", signature: "add(a: number, b: number): number" },
          {
            kind: "capability",
            name: "fetch",
            signature: "fetch(input: string | Request, init?: RequestInit): Promise<Response>",
          },
          { kind: "capability", name: "runs" },
          { kind: "capability", name: "storage" },
          { kind: "capability", name: "vault" },
        ],
      },
    });
  });

  it("keeps the slim response inside its 2KB ceiling, tags and examples out", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await search(accessToken, {});

    expect(bytes(result.structuredContent)).toBeLessThanOrEqual(2048);
    // Error tags are the field most likely to blow the ceiling as capabilities
    // accumulate, so the slim entries must not carry them - nor the example,
    // which is detail's other expensive field.
    const body = JSON.stringify(result.structuredContent);
    expect(body).not.toContain("errorTags");
    expect(body).not.toContain("example");
  });

  it("speaks TypeScript, not JSON Schema", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await search(accessToken, { query: "add two numbers" });

    const body = JSON.stringify(result.structuredContent);
    expect(body).toContain("add(a: number, b: number): number");
    // Story 7: types arrive in the language the model is about to write in.
    // What must not be there: a JSON Schema description of the same thing.
    expect(body).not.toContain('"properties"');
  });

  it("finds by intent what it finds by name", async () => {
    const { accessToken } = await mintAccessToken();

    const byIntent = await search(accessToken, { query: "add two numbers" });
    const byName = await search(accessToken, { query: "add" });

    expect(byIntent.structuredContent).toStrictEqual(byName.structuredContent);
  });

  it("returns detail only when asked, with tags and a worked example", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await search(accessToken, { name: "add" });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: {
        kind: "capability",
        name: "add",
        signature: "add(a: number, b: number): number",
        importLine: 'import { add } from "opti:capabilities";',
        errorTags: [],
      },
    });
    const value = (result.structuredContent as { value: { example: { code: string; result: unknown } } }).value;
    expect(value.example.code).toContain('from "opti:capabilities"');
    expect(value.example.result).toBe(42);
  });

  it("names what does exist when nothing matches", async () => {
    const { accessToken } = await mintAccessToken();

    // Chosen to share no token with any capability's prose - the ranking is
    // substring-based, so even "an" would match inside "sandbox".
    const result = await search(accessToken, { query: "email my boss" });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { results: [] },
    });
    // An empty answer teaches a model that nothing exists; the hint is what
    // stops that lesson from being learned.
    const value = (result.structuredContent as { value: { hint?: string } }).value;
    expect(value.hint).toContain("add");
  });

  it("lists the owner's credentials in detail for fetch - names and hosts, never values", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: "todoist-secret-value" });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "api.todoist.com" });

    const result = await search(accessToken, { name: "fetch" });

    // The moment of need is before code is written, which makes this a
    // search-time answer: the agent learns what fetch can already reach.
    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: {
        name: "fetch",
        credentials: [{ name: "todoist", hosts: ["api.todoist.com"] }],
      },
    });
    // The value that must not be present, anywhere in the response.
    expect(JSON.stringify(result.structuredContent)).not.toContain("todoist-secret-value");
  });

  it("names the saved credentials in the empty result, so a missing capability is a starting point", async () => {
    const { accessToken, identity } = await mintOwner();
    await operator("/admin/save-credential", { identity, name: "todoist", value: "todoist-secret-value" });
    await operator("/admin/approve-host", { identity, credential: "todoist", host: "api.todoist.com" });

    const result = await search(accessToken, { query: "manage my todos" });

    const value = (result.structuredContent as { value: { results: unknown[]; hint?: string } }).value;
    expect(value.results).toStrictEqual([]);
    expect(value.hint).toContain("todoist");
    expect(value.hint).toContain("api.todoist.com");
    expect(JSON.stringify(result.structuredContent)).not.toContain("todoist-secret-value");
  });

  it("keeps the slim list static: an owner's credentials do not grow the response paid on every turn", async () => {
    const withCredentials = await mintOwner();
    await operator("/admin/save-credential", {
      identity: withCredentials.identity,
      name: "todoist",
      value: "todoist-secret-value",
    });
    const fresh = await mintAccessToken();

    const listWithCredentials = await search(withCredentials.accessToken, {});
    const listFresh = await search(fresh.accessToken, {});

    // Detail for fetch is the one per-owner response; the slim list and
    // tools/list stay identical for every owner, and under their ceiling.
    expect(listWithCredentials.structuredContent).toStrictEqual(listFresh.structuredContent);
  });

  it("fails a detail request for something that does not exist, naming what does", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await search(accessToken, { name: "subtract" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "NoSuchCapability", retry: "never" },
    });
    const error = (result.structuredContent as { error: { message: string } }).error;
    expect(error.message).toContain("add");
  });
});
