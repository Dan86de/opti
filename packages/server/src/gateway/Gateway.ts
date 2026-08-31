/**
 * The fetch gateway: the seam every sandbox request crosses on its way out.
 *
 * `globalOutbound` accepts only a Fetcher, so the gateway is a
 * `WorkerEntrypoint` exported from the main module, and the runner passes
 * `ctx.exports.Gateway({ props: { ownerId, runId, origin } })` in place of
 * `null`. Authority travels in props set by the host at isolate creation and
 * never in anything the sandbox can write - the same rule as everywhere else.
 *
 * Once outbound is granted, the sandbox's raw global `fetch` works too. That
 * is fine because the virtual module was never the boundary: this entrypoint
 * applies policy to every request however the sandbox spelled `fetch`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Owner } from "../identity/index.ts";
import { denialResponse, OwnOriginRefused } from "./Denial.ts";

/**
 * What the host seals into the seam at isolate creation. Everything the
 * gateway knows about who is asking arrives here; nothing arrives in the
 * request, because the request is the sandbox's to write.
 */
export interface GatewayProps {
  readonly ownerId: Owner.OwnerId;
  readonly runId: string;
  readonly origin: string;
}

export class Gateway extends WorkerEntrypoint<unknown, GatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const { origin } = this.ctx.props;
    const target = new URL(request.url);

    // Hostname rather than origin: `http://` in front of our own host is
    // still our own host, and a scheme game must not slip past the class.
    if (target.hostname.toLowerCase() === new URL(origin).hostname.toLowerCase()) {
      return denialResponse(
        new OwnOriginRefused({
          message: "the sandbox cannot call the OPTI server it is running inside",
        }),
        403,
      );
    }

    return fetch(request);
  }
}
