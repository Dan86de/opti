/**
 * The fetch gateway: the seam every sandbox request crosses on its way out,
 * and the credential boundary itself - the most expensive thing in the spec
 * to retrofit, which is why it is a module and not a helper.
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
 *
 * The order is scan, then policy, then substitute: every named credential
 * must have the target host approved, the refusal happens before any network
 * call, and plaintext is materialized only after policy passed. This module
 * and the vault's credential store are the only places plaintext exists.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Owner } from "../identity/index.ts";
import { type OwnerVault, vaultFor } from "../vault/OwnerVault.ts";
import {
  denialResponse,
  FetchBudgetExhausted,
  HostNotApproved,
  InsecureTransport,
  OwnOriginRefused,
  UnknownCredential,
} from "./Denial.ts";
import { exemptFromSecureTransport, isSecureTransport } from "./Hosts.ts";
import { scan, substitute } from "./Placeholder.ts";

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

export interface GatewayBindings {
  readonly OWNER_VAULT: DurableObjectNamespace<OwnerVault>;
  /** The daily outbound ceiling, through the door like every number. */
  readonly FETCH_BUDGET: string;
  /** Hosts exempt from the https rule. Empty in production, always. */
  readonly GATEWAY_INSECURE_HOSTS: string;
}

/**
 * workerd percent-encodes braces in a URL, so the placeholder a sandbox
 * wrote into a query string arrives as `%7B%7Bcredential:x%7D%7D`. The scan
 * is textual and runs over the final serialized request, so the braces are
 * put back before scanning - and substitution happens on the same string, so
 * what was scanned is what is substituted.
 */
const debraced = (url: string): string => url.replace(/%7B/gi, "{").replace(/%7D/gi, "}");

const budgetExhausted = (resetsAt: string) =>
  new FetchBudgetExhausted({
    message: `the daily outbound fetch budget is spent, denials included. It resets at ${resetsAt}.`,
  });

const unknownCredential = (origin: string, names: readonly string[]) =>
  new UnknownCredential({
    message:
      `no credential named ${names.map((name) => JSON.stringify(name)).join(", ")} is saved. ` +
      `Stop and hand this to the owner to run from a terminal: ` +
      `OPTI_ORIGIN=${origin} OPTI_OPERATOR_TOKEN=... ./scripts/operator.sh save-credential <your-upstream-identity> ${names[0]}`,
  });

const hostNotApproved = (origin: string, host: string, names: readonly string[]) => {
  const first = names[0] ?? "";
  return new HostNotApproved({
    // The credential and host in plain text, so the agent can relay the
    // situation without anyone opening the link.
    message:
      `host ${host} is not approved for credential ${names.map((name) => JSON.stringify(name)).join(", ")}. ` +
      `Approving egress is the owner's decision alone; stop and hand over the approval link.`,
    action: {
      kind: "approve-host",
      url: `${origin}/approve?credential=${encodeURIComponent(first)}&host=${encodeURIComponent(host)}`,
    },
  });
};

export class Gateway extends WorkerEntrypoint<GatewayBindings, GatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const { ownerId, origin } = this.ctx.props;
    const vault = vaultFor(this.env.OWNER_VAULT, ownerId);

    // Counted first, denials included: a loop hammering denials is still a
    // runaway, and the ceiling under it is the point of the counter.
    const budget = await vault.countFetch(Number(this.env.FETCH_BUDGET));
    if (budget.exhausted) {
      return denialResponse(budgetExhausted(budget.resetsAt), 429);
    }

    const target = new URL(request.url);

    // Hostname rather than origin: `http://` in front of our own host is
    // still our own host, and a scheme game must not slip past the class.
    if (target.hostname.toLowerCase() === new URL(origin).hostname.toLowerCase()) {
      return denialResponse(
        new OwnOriginRefused({ message: "the sandbox cannot call the OPTI server it is running inside" }),
        403,
      );
    }

    // The final serialized request, as text: the URL, every header value,
    // and the body when it is text. A body that is not valid utf-8 is not a
    // text body, carries no placeholder, and passes through as bytes.
    const url = debraced(request.url);
    const headerValues = [...request.headers].map(([, value]) => value);
    const rawBody = request.body === null ? null : await request.arrayBuffer();
    let bodyText: string | null = null;
    if (rawBody !== null) {
      try {
        bodyText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody);
      } catch {
        bodyText = null;
      }
    }

    const names = scan([url, ...headerValues, bodyText ?? ""]);

    if (names.length === 0) {
      // No credential, no policy: requests carrying no credential rely on
      // the platform egress model, per the accepted residual. The request is
      // rebuilt because reading the body consumed it.
      return fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          redirect: request.redirect,
          ...(rawBody === null ? {} : { body: rawBody }),
        }),
      );
    }

    if (!isSecureTransport(target) && !exemptFromSecureTransport(this.env.GATEWAY_INSECURE_HOSTS, target.hostname)) {
      return denialResponse(
        new InsecureTransport({
          message: `a request naming a credential must be https on the default port; ${target.protocol}//${target.host} is not. The allowlist cannot override this.`,
        }),
        403,
      );
    }

    const resolution = await vault.resolveForHost(ownerId, names, target.hostname);
    if (!resolution.ok) {
      const unknown = resolution.unresolved.filter((entry) => entry.reason === "unknown").map((entry) => entry.name);
      const unapproved = resolution.unresolved
        .filter((entry) => entry.reason === "not-approved")
        .map((entry) => entry.name);
      // An unsaved credential outranks an unapproved host: approving egress
      // for a value that does not exist would grant nothing.
      return denialResponse(
        unknown.length > 0 ? unknownCredential(origin, unknown) : hostNotApproved(origin, target.hostname, unapproved),
        403,
      );
    }

    const values = new Map(Object.entries(resolution.values));
    const substituted = new Request(substitute(url, values), {
      method: request.method,
      headers: [...request.headers].map(([name, value]): [string, string] => [name, substitute(value, values)]),
      // Never follow a credentialed redirect: one approved host could
      // forward the credential to a second host nobody approved. The
      // redirect returns to the sandbox as data.
      redirect: "manual",
      ...(bodyText === null ? (rawBody === null ? {} : { body: rawBody }) : { body: substitute(bodyText, values) }),
    });

    return fetch(substituted);
  }
}
