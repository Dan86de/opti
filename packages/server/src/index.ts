/**
 * The Worker entry point.
 *
 * Note what this file does NOT do: it does not read a binding from module
 * scope. Bindings arrive as an explicit interface passed in at the door, which
 * is what makes the eventual split into separate deployables a configuration
 * change rather than surgery. Keep it that way.
 */
import { Data, Effect } from "effect";
import type { Owner, Upstream } from "./identity/index.ts";
import { Envelope, type Failure } from "./kernel/index.ts";

/**
 * Everything the request path is allowed to reach.
 *
 * Composed from what each module declares it needs rather than written out
 * here, so a module's requirements are stated next to the code that has them
 * and this stays a list of who is at the door.
 *
 * Not yet in `wrangler.jsonc`: the identity bindings have no production
 * counterpart until the GitHub application and the KV namespace exist. Nothing
 * in the request path reads them yet, and wiring them in waits on the config
 * catching up.
 */
export interface Bindings extends Upstream.UpstreamBindings, Owner.OwnerBindings {}

export class NoSuchRoute extends Data.TaggedError("NoSuchRoute")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * The handler, as an Effect over the bindings it was handed.
 *
 * A walking skeleton: it proves the runtime boots inside workerd, that a result
 * comes back in the envelope, and that a failure keeps its tag across the
 * boundary. There is no product here, which is the point.
 */
const handle = (request: Request, _bindings: Bindings) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      return yield* new NoSuchRoute({ message: `no route for ${url.pathname}` });
    }
    return { service: "opti" as const };
  });

const toResponse = <A>(envelope: Envelope.Envelope<A>): Response =>
  new Response(JSON.stringify(envelope), {
    status: envelope.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const exit = await Effect.runPromise(Effect.exit(handle(request, env)));
    return toResponse(Envelope.fromExit(exit));
  },
} satisfies ExportedHandler<Bindings>;
