/**
 * The gateway's internal route: how `storage` and `runs` reach the owner
 * store from inside an isolate.
 *
 * Derived rather than decided: the isolate receives no `env` - that absence
 * is the boundary - so the only channel out is `globalOutbound`, which is the
 * gateway. Storage calls travel as fetches to a reserved hostname on the
 * `.internal` TLD, which can never be a real host, and the gateway routes
 * them to the owner's store instead of the network. Authority is the host-set
 * props, the same rule as credential resolution: nothing the sandbox writes
 * can address another owner's store.
 *
 * Failures leave as the marked synthetic response the denial transport
 * already defined, so the capability wrappers turn them into tagged throws
 * the entry module knows how to carry.
 */
import type { Failure } from "../kernel/index.ts";
import type { OwnerStore } from "../store/OwnerStore.ts";
import { NoSuchRun, type RunQuery } from "../store/RunRecords.ts";
import { checkKey, checkValueSize } from "../store/StorageData.ts";
import { denialResponse } from "./Denial.ts";

/** Reserved: the `.internal` TLD is not delegated, so this can never collide
 * with a host anybody could approve. */
export const INTERNAL_HOST = "opti.internal";

/** What the gateway's caller needs for the trail: the response, and the
 * failure tag when the call was refused. */
export interface Routed {
  readonly response: Response;
  readonly denied?: string;
}

const json = (body: string): Routed => ({
  response: new Response(body, { headers: { "content-type": "application/json" } }),
});

const denied = (error: Failure.OptiError, status: number): Routed => ({
  response: denialResponse(error, status),
  denied: error._tag,
});

/** A call the internal route cannot read. Modelled as its own plain failure
 * rather than a class: it only ever exists inside this module. */
const malformed = (message: string): Routed => denied({ _tag: "MalformedInternalCall", message, retry: "never" }, 400);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OUTCOMES = ["success", "failure"] as const;

/** The query filter, checked field by field: the sandbox wrote this body, so
 * a wrong shape is likely and deserves a message naming the field. */
const runQuery = (body: Record<string, unknown>): RunQuery | string => {
  const filter: {
    since?: string;
    until?: string;
    source?: string;
    outcome?: (typeof OUTCOMES)[number];
    limit?: number;
  } = {};
  for (const field of ["since", "until", "source"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string") {
        return `${field} must be a string`;
      }
      filter[field] = value;
    }
  }
  if (body["outcome"] !== undefined) {
    const outcome = OUTCOMES.find((candidate) => candidate === body["outcome"]);
    if (outcome === undefined) {
      return 'outcome must be "success" or "failure"';
    }
    filter.outcome = outcome;
  }
  if (body["limit"] !== undefined) {
    if (typeof body["limit"] !== "number") {
      return "limit must be a number";
    }
    filter.limit = body["limit"];
  }
  return filter;
};

/**
 * Answer one internal call. The store stub arrives resolved for the owner in
 * the gateway's props; nothing in the request can address any other.
 */
export const handleInternal = async (
  store: DurableObjectStub<OwnerStore>,
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
    case "/storage/get":
    case "/storage/set":
    case "/storage/delete": {
      const key = body["key"];
      if (typeof key !== "string") {
        return malformed("key must be a string");
      }
      const invalidKey = checkKey(key);
      if (invalidKey !== null) {
        return denied(invalidKey, 400);
      }
      if (pathname === "/storage/get") {
        const stored = await store.storageGet(key);
        // The stored text is already JSON; it is spliced, not re-encoded.
        return json(`{"value":${stored ?? "null"}}`);
      }
      if (pathname === "/storage/delete") {
        return json(JSON.stringify({ deleted: await store.storageDelete(key) }));
      }
      if (!("value" in body)) {
        return malformed("set needs a value");
      }
      const valueJson = JSON.stringify(body["value"]);
      const tooLarge = checkValueSize(valueJson);
      if (tooLarge !== null) {
        return denied(tooLarge, 413);
      }
      await store.storageSet(key, valueJson);
      return json('{"ok":true}');
    }

    case "/storage/list": {
      const prefix = body["prefix"] ?? "";
      if (typeof prefix !== "string" || (prefix !== "" && checkKey(prefix) !== null)) {
        return malformed("prefix must be a string of key characters, or absent for everything");
      }
      return json(JSON.stringify(await store.storageList(prefix)));
    }

    case "/runs/query": {
      const filter = runQuery(body);
      if (typeof filter === "string") {
        return malformed(filter);
      }
      return json(JSON.stringify(await store.queryRuns(filter)));
    }

    case "/runs/get": {
      if (typeof body["runId"] !== "string") {
        return malformed("runId must be a string");
      }
      const record = await store.getRun(body["runId"]);
      if (record === null) {
        return denied(new NoSuchRun({ message: `no run record is named ${JSON.stringify(body["runId"])}` }), 404);
      }
      // Already JSON text; spliced, not re-encoded.
      return json(record);
    }

    default:
      return malformed(`no internal route at ${pathname}`);
  }
};
