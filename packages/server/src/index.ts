/**
 * The Worker entry point.
 *
 * Note what this file does NOT do: it does not read a binding from module
 * scope. Bindings arrive as an explicit interface passed in at the door, which
 * is what makes the eventual split into separate deployables a configuration
 * change rather than surgery. The OAuth provider is built per request for the
 * same reason - its configuration is derived from the request's own origin, so
 * there is no deployment-specific constant to keep in step with reality.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Data, Effect } from "effect";
import * as Authorize from "./http/Authorize.ts";
import type { Owner, Upstream } from "./identity/index.ts";
import { Envelope, type Failure } from "./kernel/index.ts";

/**
 * Everything the request path is allowed to reach.
 *
 * Composed from what each module declares it needs rather than written out
 * here, so a module's requirements are stated next to the code that has them
 * and this stays a list of who is at the door.
 */
export interface Bindings extends Upstream.UpstreamBindings, Owner.OwnerBindings, Authorize.AuthorizeBindings {}

/** Where the MCP surface will live. Everything under it needs a valid token. */
const MCP_ROUTE = "/mcp";

export class NoSuchRoute extends Data.TaggedError("NoSuchRoute")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

const toResponse = <A>(envelope: Envelope.Envelope<A>): Response =>
  new Response(JSON.stringify(envelope), {
    status: envelope.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });

/**
 * Everything that is not the MCP surface: the login screens, and the envelope
 * for anything else.
 */
const defaultHandler = {
  async fetch(request: Request, bindings: Bindings): Promise<Response> {
    const browserResponse = await Effect.runPromise(Authorize.handle(request, bindings));
    if (browserResponse !== null) {
      return browserResponse;
    }

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const url = new URL(request.url);
          if (url.pathname !== "/health") {
            return yield* new NoSuchRoute({ message: `no route for ${url.pathname}` });
          }
          return { service: "opti" as const };
        }),
      ),
    );
    return toResponse(Envelope.fromExit(exit));
  },
} satisfies ExportedHandler<Bindings>;

/**
 * The MCP surface, reached only with a valid access token.
 *
 * A placeholder that answers with the owner id, which is the one thing worth
 * asserting before the tools exist: that the id comes from the authenticated
 * request and from nowhere else. `search` and `execute` replace this.
 */
const apiHandler = {
  async fetch(_request: Request, _bindings: Bindings, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as { ownerId?: string } | undefined;
    return toResponse(Envelope.succeed({ ownerId: props?.ownerId ?? null }));
  },
} satisfies ExportedHandler<Bindings>;

/**
 * Build the provider for this request.
 *
 * `resourceMetadata.resource` pins both the grant and the access token's
 * audience to this exact resource, which is what stops a token minted for
 * something else being replayed here. It is derived from the request's origin
 * rather than configured, so it is right in every environment without anything
 * to keep in step.
 */
const provider = (origin: string) =>
  new OAuthProvider<Bindings>({
    apiRoute: MCP_ROUTE,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // Story 3: a client registers itself rather than being provisioned by hand.
    clientRegistrationEndpoint: "/register",
    resourceMetadata: {
      resource: `${origin}${MCP_ROUTE}`,
      resource_name: "OPTI",
    },
  });

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    return provider(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;
