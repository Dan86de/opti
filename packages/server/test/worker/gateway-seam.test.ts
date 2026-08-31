/**
 * The seam: every way out of the sandbox now leads to the gateway.
 *
 * Slice 1 proved `globalOutbound: null` closes fetch, sockets and node:net in
 * one gate. Slice 2 replaces the null with the `Gateway` entrypoint, and this
 * file is the proof that the replacement is a seam and not a hole: `fetch`
 * flows out through the gateway, the socket paths stay dead because a Fetcher
 * outbound answers `fetch` and nothing else, and the worker's own origin is
 * refused as a class before any network happens.
 *
 * Props intactness is asserted through behaviour rather than introspection -
 * the own-origin refusal only works if the `origin` prop the host sealed
 * survived to the gateway - because a test-only echo endpoint on the gateway
 * would be a code path the deployed worker carries for nobody.
 *
 * Local/production difference, recorded per the testing decisions: this runs
 * against miniflare's Worker Loader and loopback bindings. The same probes
 * must be run once against the deployed worker before the seam claims are
 * about production; local and production have disagreed before.
 */
import { describe, expect, it } from "vitest";
import { FAILURE_HEADER } from "../../src/gateway/Denial.ts";
import { BANNER } from "./support/listener.ts";
import { LISTENER_ORIGIN } from "./support/listener-address.ts";
import { callTool, ORIGIN } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

const connectionsSeen = async (): Promise<number> => Number(await (await fetch(`${LISTENER_ORIGIN}/count`)).text());

describe("the seam", () => {
  it("routes sandbox fetch out through the gateway to the wire", async () => {
    const { accessToken } = await mintAccessToken();
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      `export default async () => {
         const response = await fetch("${LISTENER_ORIGIN}/from-sandbox");
         return { status: response.status, body: await response.text() };
       };`,
    );

    // Both accounts agree: the sandbox saw the listener's answer, and the
    // listener saw exactly one connection arrive.
    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { result: { status: 200, body: BANNER } },
    });
    expect(await connectionsSeen()).toBe(before + 1);
  });

  // FINDING, 2026-08-31, local: workerd routes a sandbox `connect()` to the
  // outbound entrypoint's `connect()` method - so the socket paths are dead
  // not because a Fetcher cannot carry them but because `Gateway` deliberately
  // defines no such method. The day sockets are wanted, that method is the
  // seam; until then its absence is the refusal.
  it("keeps the socket paths dead: the gateway answers fetch and nothing else", async () => {
    const { accessToken } = await mintAccessToken();
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      `const probe = async (fn) => {
         try { return "OK " + (await fn()) } catch (e) { return "ERR " + ((e && e.message) || String(e)) }
       };
       export default async () => ({
         sockets: await probe(async () => {
           const { connect } = await import("cloudflare:sockets");
           const socket = connect("${LISTENER_ORIGIN.replace(/^http:\/\//, "")}");
           await socket.writable.getWriter().write(new TextEncoder().encode("probe\\n"));
           const { value } = await socket.readable.getReader().read();
           return new TextDecoder().decode(value);
         }),
         nodeNet: await probe(async () => {
           const net = await import("node:net");
           return await new Promise((resolve, reject) => {
             const socket = net.createConnection({ host: "127.0.0.1", port: 43199 }, () => socket.write("probe\\n"));
             socket.on("data", (chunk) => resolve(String(chunk)));
             socket.on("error", reject);
             setTimeout(() => reject(new Error("timed out")), 3000);
           });
         }),
       });`,
    );

    const value = (result.structuredContent as { value: { result: { sockets: string; nodeNet: string } } }).value;
    expect(value.result.sockets).toMatch(/^ERR/);
    expect(value.result.nodeNet).toMatch(/^ERR/);
    // The listener's account, not the sandbox's: no connection was made.
    expect(await connectionsSeen()).toBe(before);
  });

  it("refuses the worker's own origin before any network, with the marked denial", async () => {
    const { accessToken } = await mintAccessToken();

    // Raw global fetch on purpose: the wrapper in opti:capabilities is a
    // convenience, and the refusal must hold for however fetch was spelled.
    // Seeing OwnOriginRefused here is also the proof that the origin prop the
    // host sealed at isolate creation arrived at the gateway intact.
    const result = await execute(
      accessToken,
      `export default async () => {
         const response = await fetch("${ORIGIN}/mcp", { method: "POST", body: "{}" });
         return { marker: response.headers.get("${FAILURE_HEADER}"), failure: await response.json() };
       };`,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: {
        result: {
          marker: "1",
          failure: { tag: "OwnOriginRefused", retry: "never" },
        },
      },
    });
  });

  it("refuses its own origin whatever the scheme says", async () => {
    const { accessToken } = await mintAccessToken();

    // Hostname, not origin: http:// in front of our own host is still our own
    // host, and a scheme game must not slip past the class.
    const result = await execute(
      accessToken,
      `export default async () => {
         const response = await fetch("${ORIGIN.replace("https://", "http://")}/mcp", { method: "POST", body: "{}" });
         return (await response.json()).tag;
       };`,
    );

    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: "OwnOriginRefused" } });
  });
});
