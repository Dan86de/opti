/**
 * Drive the MCP surface the way a model's host drives it. The transport's own
 * tests speak raw bodies and read headers; everything above the transport
 * talks through these.
 */
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { Envelope } from "../../../src/kernel/index.ts";

export const ORIGIN = "https://opti.test";

export interface CallResult {
  content: { type: string; text: string }[];
  structuredContent: Envelope.Envelope<unknown>;
  isError?: boolean;
}

export const rpc = async (accessToken: string, method: string, params: unknown): Promise<unknown> => {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: unknown }).result;
};

export const callTool = async (accessToken: string, name: string, args: unknown): Promise<CallResult> =>
  (await rpc(accessToken, "tools/call", { name, arguments: args })) as CallResult;
