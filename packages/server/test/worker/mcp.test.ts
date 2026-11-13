/**
 * The MCP transport: stateless JSON-RPC over one POST endpoint.
 *
 * The decision under test is statelessness. `McpServer.layerHttp` keeps
 * sessions in an in-memory map that an evicted isolate forgets, so a
 * well-behaved host would be told to start over at unpredictable moments.
 * OPTI issues no session id at all, which the protocol permits, so the
 * 404-on-forgotten-session path does not exist. The assertions here are
 * therefore mostly negative: the header that was not issued, the state that
 * was not required.
 */
import { SELF } from "cloudflare:test";
import { Schema } from "effect";
import { McpSchema } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { mintAccessToken } from "./support/token.ts";

const ORIGIN = "https://opti.test";

const rpc = (accessToken: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

const initialize = (id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-host", version: "0.0.0" },
  },
});

describe("initialize", () => {
  it("answers initialize and never issues a session id", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await rpc(accessToken, initialize());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "opti" },
      },
    });
    // The statelessness decision, as the thing that must not have happened: no
    // session was created, so no request can ever be refused for lacking one.
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers in a shape the library's own schema accepts", async () => {
    // The transport shell is ours, so the wire shape is held to McpSchema's
    // account of the protocol rather than to our opinion of it.
    const { accessToken } = await mintAccessToken();

    const body = (await (await rpc(accessToken, initialize())).json()) as { result: unknown };

    expect(() => Schema.decodeUnknownSync(McpSchema.InitializeResult)(body.result)).not.toThrow();
  });

  it("serves a request that arrives with no session, because there are none", async () => {
    const { accessToken } = await mintAccessToken();

    // No initialize first, no session header: a fresh isolate that forgot
    // everything must still answer, or eviction becomes a user-visible fault.
    const response = await rpc(accessToken, { jsonrpc: "2.0", id: 7, method: "ping" });

    expect(await response.json()).toStrictEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("protocol revisions", () => {
  const rpcAt = (accessToken: string, version: string, body: unknown) =>
    SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": version,
      },
      body: JSON.stringify(body),
    });

  it.each(["2025-11-25", "2025-06-18", "2025-03-26"])(
    "serves a host that states %s on every request, initialize included",
    async (version) => {
      // A current host sends the header on initialize too. Refusing it there
      // is what left claude.ai's connector with no tools rather than an error.
      const { accessToken } = await mintAccessToken();

      const initialized = await rpcAt(accessToken, version, {
        ...initialize(),
        params: { ...initialize().params, protocolVersion: version },
      });
      const listed = await rpcAt(accessToken, version, { jsonrpc: "2.0", id: 2, method: "tools/list" });

      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({ result: { protocolVersion: version } });
      expect(listed.status).toBe(200);
      const { result } = (await listed.json()) as { result: { tools: { name: string }[] } };
      expect(result.tools.map((tool) => tool.name)).toStrictEqual(["search", "execute", "packages"]);
    },
  );

  it("offers the newest revision to a host that asks for one it does not know", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await rpc(accessToken, {
      ...initialize(),
      params: { ...initialize().params, protocolVersion: "2099-01-01" },
    });

    expect(await response.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  });

  it("refuses a stated revision it does not speak, and lists no tools under it", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await rpcAt(accessToken, "2099-01-01", { jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(body).not.toHaveProperty("result");
  });
});

describe("notifications", () => {
  it("acknowledges notifications/initialized with 202 and no body", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await rpc(accessToken, { jsonrpc: "2.0", method: "notifications/initialized" });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });
});

describe("protocol faults", () => {
  it("refuses a method that does not exist, as JSON-RPC and not as an envelope", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await rpc(accessToken, { jsonrpc: "2.0", id: 2, method: "resources/list" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 2, error: { code: -32601 } });
  });

  it("refuses a body that is not JSON", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: "not json {",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  it("refuses GET, because a stateless server has nothing to stream", async () => {
    const { accessToken } = await mintAccessToken();

    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("the owner at the door", () => {
  it("refuses a grant that did not seal an owner id, before any method runs", async () => {
    // Only the minting helper can make this grant: the real login always seals
    // an owner id, which is exactly why the surface must not assume it.
    const { accessToken } = await mintAccessToken({ login: "sealed-nothing" });

    const response = await rpc(accessToken, initialize());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } });
  });
});
