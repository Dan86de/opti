/**
 * The gateway's vault route: how the `vault` capability reaches the vault
 * container from inside an isolate.
 *
 * Same channel as `storage` - a fetch to the reserved `.internal` hostname,
 * routed here instead of the network - and the same protocol: POST, JSON
 * body, denials leaving as the marked synthetic response. The write-prefix
 * policy is applied here, before the backend is called, so a refused write
 * is a request the container never saw.
 *
 * The backend is a function rather than a stub type on purpose: production
 * hands in the container's fetch, tests hand in the loopback double through
 * `VAULT_ORIGIN`, and this module cannot tell the difference - the same
 * bindings-at-the-door rule as everywhere else.
 */
import type { Failure } from "../kernel/index.ts";
import { denialResponse } from "./Denial.ts";
import type { Routed } from "./Internal.ts";
import { checkWrite, InvalidVaultPath, NoSuchNote, normalizePath, VaultUnavailable } from "./VaultPolicy.ts";

/** One call into the vault container: a container-API path in, its response
 * out. Throwing is allowed; it becomes `VaultUnavailable`. */
export type VaultBackend = (path: string, init?: RequestInit) => Promise<Response>;

const json = (body: string): Routed => ({
  response: new Response(body, { headers: { "content-type": "application/json" } }),
});

const denied = (error: Failure.OptiError, status: number): Routed => ({
  response: denialResponse(error, status),
  denied: error._tag,
});

const malformed = (message: string): Routed => denied({ _tag: "MalformedInternalCall", message, retry: "never" }, 400);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The container answered with something other than its API: not JSON, or a
 * status the route does not translate. The body is not echoed - a broken
 * container's output is nobody's error message. */
const unavailable = (): Routed =>
  denied(
    new VaultUnavailable({
      message: "the vault container did not answer; it may be waking or resyncing. Retry shortly.",
    }),
    503,
  );

/** Splice a container response through, translating the one status that has
 * a meaning of its own. */
const relay = async (backendCall: Promise<Response>, missing?: () => Failure.OptiError): Promise<Routed> => {
  let response: Response;
  try {
    response = await backendCall;
  } catch {
    return unavailable();
  }
  if (response.status === 404 && missing !== undefined) {
    return denied(missing(), 404);
  }
  if (!response.ok) {
    return unavailable();
  }
  return json(await response.text());
};

export const handleVault = async (
  backend: VaultBackend,
  writePrefixes: string,
  request: Request,
  pathname: string,
): Promise<Routed> => {
  if (request.method !== "POST") {
    return malformed(`internal calls are POST, not ${request.method}`);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return malformed("the body is not JSON");
  }
  if (!isRecord(body)) {
    return malformed("the body is a JSON object");
  }

  switch (pathname) {
    case "/vault/read": {
      const path = normalizePath(body["path"]);
      if (path instanceof InvalidVaultPath) {
        return denied(path, 400);
      }
      return relay(
        backend(`/read?path=${encodeURIComponent(path)}`),
        () => new NoSuchNote({ message: `no note at ${JSON.stringify(path)}` }),
      );
    }

    case "/vault/write": {
      const path = normalizePath(body["path"]);
      if (path instanceof InvalidVaultPath) {
        return denied(path, 400);
      }
      if (typeof body["content"] !== "string") {
        return malformed("content must be a string");
      }
      // Policy before the backend: a refused write is a request the
      // container never saw, and the negative assertion in the tests holds
      // it to that.
      const refused = checkWrite(writePrefixes, path);
      if (refused !== null) {
        return denied(refused, 403);
      }
      return relay(
        backend("/write", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content: body["content"] }),
        }),
      );
    }

    case "/vault/list": {
      if (body["folder"] === undefined) {
        return relay(backend("/list"));
      }
      const folder = normalizePath(body["folder"]);
      if (folder instanceof InvalidVaultPath) {
        return denied(folder, 400);
      }
      return relay(backend(`/list?folder=${encodeURIComponent(folder)}`));
    }

    case "/vault/search": {
      const query = body["query"];
      if (typeof query !== "string" || query.length === 0) {
        return malformed("query must be a non-empty string");
      }
      return relay(backend(`/search?q=${encodeURIComponent(query)}`));
    }

    default:
      return malformed(`no vault route at ${pathname}`);
  }
};
