/**
 * Mint an access token without the OAuth dance.
 *
 * The tests about the MCP surface are about the surface, not about the login,
 * so an assertion about a size ceiling should not pay for registration,
 * consent, a doubled upstream and a code exchange. This goes straight to the
 * provider's own API - the same `providerOptions` the deployed worker uses, so
 * the grant it creates is indistinguishable from one the real flow made.
 *
 * SHORTCUT, recorded per the testing decisions: the authorization that seals
 * these props never happened. What sealing does on a real login is proved in
 * authorize.test.ts; here the props are written directly, which is exactly
 * what makes it possible to mint a grant with the wrong shape on purpose.
 */

import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { expect } from "vitest";
import { type Bindings, providerOptions } from "../../../src/index.ts";

const ORIGIN = "https://opti.test";
const REDIRECT = "https://minter.example/callback";

/**
 * A minted owner id in the same shape `Owner.resolveOwner` generates. Distinct
 * per call, so two minted tokens are two owners unless a test says otherwise.
 */
export const mintedOwnerId = () => `own_${crypto.randomUUID()}`;

/**
 * Mint a token whose grant carries the given props, defaulting to the shape
 * the real login seals. Passing something else is the point: the surface must
 * refuse a grant that did not seal an owner id.
 */
export const mintAccessToken = async (props?: Record<string, unknown>) => {
  const ownerId = mintedOwnerId();
  // The generated `Env` describes `wrangler.jsonc`; the pool attaches the rest.
  // Reconciled once here, the same way identity.test.ts does it.
  const api = getOAuthApi(providerOptions(ORIGIN), env as typeof env & Bindings);

  const client = await api.createClient({
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: "client_secret_post",
  });

  const { redirectTo } = await api.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri: REDIRECT,
      scope: [],
      state: "minted",
    },
    userId: ownerId,
    metadata: {},
    scope: [],
    props: props ?? { ownerId, login: "minted-owner" },
  });

  const code = new URL(redirectTo).searchParams.get("code") ?? "";

  // The exchange still goes through the real /token endpoint, so what comes
  // back is a token the deployed code path minted, not a look-alike.
  const response = await SELF.fetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.clientId,
      client_secret: client.clientSecret ?? "",
    }).toString(),
  });
  expect(response.status).toBe(200);
  const granted = (await response.json()) as { access_token: string };

  return { accessToken: granted.access_token, ownerId };
};
