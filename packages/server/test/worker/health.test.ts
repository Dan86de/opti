/**
 * Anything that touches workerd runs here, under the Workers pool, so that a
 * green run is evidence about the runtime we actually deploy to.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("is running in workerd and not in node", () => {
    // The two-runner split is only worth anything if this project really
    // starts the Workers runtime. If this ever passes under node, every other
    // assertion in this directory proved less than it looks like it proved.
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("boots the Effect runtime inside workerd and answers in the envelope", async () => {
    const response = await SELF.fetch("https://opti.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true, value: { service: "opti" } });
  });

  it("returns a failure in the same shape as a success", async () => {
    const response = await SELF.fetch("https://opti.test/nope");
    const body = await response.json();

    expect(body).toMatchObject({ ok: false, error: { tag: "NoSuchRoute", retry: "never" } });
  });

  it("does not leak a stack trace across the boundary", async () => {
    const response = await SELF.fetch("https://opti.test/nope");
    const body = (await response.text()).toLowerCase();

    // A failure carries a tag and a retry classification so a caller can
    // recover without reading a stack trace - so the stack must not be there.
    expect(body).not.toContain("stack");
    expect(body).not.toContain(".ts:");
    expect(body).not.toContain("at ");
  });
});
