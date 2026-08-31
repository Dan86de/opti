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
import { Data, Effect, Exit } from "effect";
import * as Admin from "./admin/Admin.ts";
import * as Search from "./discovery/Search.ts";
import * as Approve from "./http/Approve.ts";
import * as Authorize from "./http/Authorize.ts";
import { Owner, type Upstream } from "./identity/index.ts";
import { Envelope, type Failure } from "./kernel/index.ts";
import * as Transport from "./mcp/Transport.ts";
import * as Registry from "./registry/Registry.ts";
import * as Execute from "./runner/Execute.ts";
import type * as Runner from "./runner/Runner.ts";

// The seam. `globalOutbound` accepts only a Fetcher, so the gateway is a
// WorkerEntrypoint on the main module, reached through `ctx.exports` with
// props the host seals at isolate creation.
export { Gateway } from "./gateway/Gateway.ts";

// The owner vault, one per owner: credentials, host policy, daily counters.
export { OwnerVault } from "./vault/OwnerVault.ts";

/**
 * Everything the request path is allowed to reach.
 *
 * Composed from what each module declares it needs rather than written out
 * here, so a module's requirements are stated next to the code that has them
 * and this stays a list of who is at the door.
 */
export interface Bindings
  extends Upstream.UpstreamBindings,
    Owner.OwnerBindings,
    Authorize.AuthorizeBindings,
    Runner.RunnerBindings,
    Admin.AdminBindings {}

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

    // The approval link's landing page: reads nothing, writes nothing.
    const approvePage = Approve.handle(request);
    if (approvePage !== null) {
      return approvePage;
    }

    // The operator surface, under its own token and never under OAuth.
    const adminResponse = await Effect.runPromise(Admin.handle(request, bindings));
    if (adminResponse !== null) {
      return adminResponse;
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
 * The owner id comes from the props the login sealed into the grant, and from
 * nowhere else. A grant without one is refused before any method dispatch, so
 * no tool can ever run without knowing whose it is - which is the property the
 * old placeholder existed to assert, kept here as the door check.
 */
const apiHandler = {
  async fetch(request: Request, bindings: Bindings, ctx: ExecutionContext): Promise<Response> {
    const owner = await Effect.runPromise(Effect.exit(Owner.fromGrantProps(ctx.props)));
    if (Exit.isFailure(owner)) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "this grant carries no owner id. Authorize again to get one." },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    // Tools are built here, at the door, per request: each handler is bound to
    // this owner and these bindings, so the transport never sees either.
    // Slice 1 resolves the same built-ins for every owner; the per-owner half
    // of the registry arrives with packages in Slice 3.
    const ownerId = owner.value;
    const origin = new URL(request.url).origin;
    const tools: readonly Transport.ServedTool[] = [
      Transport.serve(Search.tool, (input) => Search.run(Registry.builtIns, input)),
      Transport.serve(Execute.tool, (input) =>
        Execute.run(bindings, { ownerId, origin, gateway: ctx.exports.Gateway }, input),
      ),
    ];

    return Effect.runPromise(Transport.handle(request, tools));
  },
} satisfies ExportedHandler<Bindings>;

/**
 * The provider's configuration for this request.
 *
 * `resourceMetadata.resource` pins both the grant and the access token's
 * audience to this exact resource, which is what stops a token minted for
 * something else being replayed here. It is derived from the request's origin
 * rather than configured, so it is right in every environment without anything
 * to keep in step.
 *
 * Exported so the tests about the MCP surface can mint tokens through
 * `getOAuthApi` against this exact configuration rather than a look-alike.
 */
export const providerOptions = (origin: string) => ({
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

const provider = (origin: string) => new OAuthProvider<Bindings>(providerOptions(origin));

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    return provider(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;
