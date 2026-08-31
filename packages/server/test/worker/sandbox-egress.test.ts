/**
 * The sandbox egress boundary.
 *
 * Slice 1 claims the boundary is `globalOutbound` plus the absent `env`, and
 * not the module map. The loader spike showed the sandbox can import `node:`
 * builtins it was never granted, so the reachable set is wider than the virtual
 * module - which makes the virtual module a grant list, and makes this file the
 * place the actual boundary is proved.
 *
 * Slice 2's credential boundary is built entirely on top of this. If any path
 * reaches the network without passing `globalOutbound`, the fetch gateway is a
 * convention rather than a boundary, and a host allowlist constrains only the
 * code that chose to go through it. That is why an escape here stops the slice
 * instead of being written down and carried.
 *
 * Both halves are needed. "The connection failed" proves nothing on its own,
 * because it is equally consistent with a test environment that has no network
 * at all. The granted case is the control that makes the denied case evidence.
 *
 * Local/production difference, recorded per the testing decisions: this runs
 * against miniflare's Worker Loader, not Cloudflare's, and against a listener on
 * loopback rather than a real remote host. Nothing here proves the production
 * boundary until the same file runs against it.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BANNER } from "./support/listener.ts";
import { LISTENER_ORIGIN } from "./support/listener-address.ts";

const COMPATIBILITY_DATE = "2026-08-31";

/**
 * Three ways out of an isolate, tried from inside one.
 *
 * Every import here is dynamic and every probe is caught separately, so one
 * path being unavailable reports itself rather than failing the module and
 * hiding the other two.
 */
const PROBES = `
const probe = async (fn) => {
  try { return "OK " + (await fn()) } catch (e) { return "ERR " + ((e && e.message) || String(e)) }
};

export default {
  async fetch() {
    return Response.json({
      fetch: await probe(async () => {
        const response = await fetch("${LISTENER_ORIGIN}/probe");
        return response.status + " " + (await response.text());
      }),
      sockets: await probe(async () => {
        const { connect } = await import("cloudflare:sockets");
        const socket = connect("${LISTENER_ORIGIN.replace(/^http:\/\//, "")}");
        await socket.writable.getWriter().write(new TextEncoder().encode("probe-sockets\\n"));
        const { value } = await socket.readable.getReader().read();
        return new TextDecoder().decode(value).trim();
      }),
      nodeNet: await probe(async () => {
        const net = await import("node:net");
        return await new Promise((resolve, reject) => {
          const socket = net.createConnection(${JSON.stringify({ host: "127.0.0.1", port: 43199 })}, () =>
            socket.write("probe-node-net\\n"),
          );
          socket.on("data", (chunk) => resolve(String(chunk).trim()));
          socket.on("error", reject);
          setTimeout(() => reject(new Error("timed out")), 3000);
        });
      }),
    });
  },
};
`;

interface ProbeResults {
  readonly fetch: string;
  readonly sockets: string;
  readonly nodeNet: string;
}

/**
 * Load an isolate holding the probes and run all three.
 *
 * `denied` passes `globalOutbound: null`, which is what the runner does.
 * `granted` omits the field, so the isolate inherits the host's outbound; that
 * is the control, and it is deliberately more permissive than anything the
 * runner will ever load.
 *
 * `env` is omitted in both: the isolate gets no parent environment, so nothing
 * here can reach the network by way of a binding either.
 */
const probeEgress = async (outbound: "granted" | "denied"): Promise<ProbeResults> => {
  const stub = env.LOADER.get(`egress-${outbound}`, () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: "main.js",
    modules: { "main.js": PROBES },
    ...(outbound === "denied" ? { globalOutbound: null } : {}),
  }));
  const response = await stub.getEntrypoint().fetch("https://sandbox.invalid/");
  return (await response.json()) as ProbeResults;
};

/** What the listener saw, asked from the host rather than from the sandbox. */
const connectionsSeen = async (): Promise<number> => Number(await (await fetch(`${LISTENER_ORIGIN}/count`)).text());

describe("sandbox egress", () => {
  it("reaches the listener on all three paths when outbound is granted", async () => {
    // The control. Without it, the denial below is indistinguishable from a
    // test environment that simply has no network, and would keep passing if
    // the listener were never started at all.
    const before = await connectionsSeen();

    const results = await probeEgress("granted");

    expect(results).toStrictEqual({
      fetch: `OK 200 ${BANNER}`,
      sockets: `OK ${BANNER}`,
      nodeNet: `OK ${BANNER}`,
    });
    expect(await connectionsSeen()).toBe(before + 3);
  });

  it("reaches nothing at all when globalOutbound is null", async () => {
    const before = await connectionsSeen();

    const results = await probeEgress("denied");

    // workerd refuses all three with one message, which is the finding: fetch,
    // `cloudflare:sockets` and `node:net` are not three doors with three locks,
    // they are three ways of asking the same gate. As of 2026-08-31 it reads
    // "This worker is not permitted to access the internet via global functions
    // like fetch()." The wording is not asserted - the silence on the wire is.
    expect(results.fetch).toMatch(/^ERR/);
    expect(results.sockets).toMatch(/^ERR/);
    expect(results.nodeNet).toMatch(/^ERR/);

    // The assertion this file exists for: not that an error was reported, but
    // that no connection was made. An error message is the sandbox's account of
    // itself; the count is the listener's.
    expect(await connectionsSeen()).toBe(before);
  });
});
