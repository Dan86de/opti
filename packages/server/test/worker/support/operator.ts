/**
 * Drive the operator surface the way the operator script drives it, for the
 * tests that need an owner reachable both ways: an access token for the MCP
 * surface, and an identity mapping so the admin routes can address the same
 * owner by `github:<subject>`, the way a first login would have wired it.
 */
import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { ORIGIN } from "./mcp.ts";
import { mintAccessToken } from "./token.ts";

export const OPERATOR_TOKEN = "test-operator-token";

let nextSubject = 880000;

export const mintOwner = async () => {
  const { accessToken, ownerId } = await mintAccessToken();
  const identity = `github:${nextSubject++}`;
  await env.OAUTH_KV.put(`identity:${identity}`, ownerId);
  return { accessToken, ownerId, identity };
};

export const operator = async (path: string, body: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};
