/**
 * The Worker Loader spike.
 *
 * Worker Loader is open beta and is the most load-bearing dependency in the
 * system: it is meant to deliver the isolate, control over what bindings the
 * loaded worker receives, and the module map, all from one binding. This file
 * is where that bet is checked rather than assumed.
 *
 * Every assertion here is about the sandbox boundary, so most of them are
 * negative: what the loaded code could NOT reach.
 *
 * Local/production difference, recorded per the testing decisions: this runs
 * against miniflare's Worker Loader, not Cloudflare's. The API surface and the
 * failures below are miniflare's account of it. Deploying the loader for real
 * needs the paid plan, and nothing here proves the production boundary until
 * the same file runs against it.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const COMPATIBILITY_DATE = "2026-08-31";

/**
 * Load a one-off isolate.
 *
 * Note what is NOT passed: no `env`, so the isolate receives no parent
 * environment; no `globalOutbound`, which is the seam slice 2 replaces with the
 * gateway. Names are unique per test because `get` caches by name.
 */
const load = (name: string, modules: Record<string, string | { js: string }>) =>
  env.LOADER.get(name, () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: "main.js",
    modules,
  }));

const call = async (stub: ReturnType<typeof load>) => {
  const response = await stub.getEntrypoint().fetch("https://sandbox.invalid/");
  return { status: response.status, body: await response.text() };
};

describe("worker loader", () => {
  it("boots an isolate that adds two numbers", async () => {
    const stub = load("adds", {
      "main.js": "export default { fetch() { return new Response(String(2 + 2)) } }",
    });

    expect(await call(stub)).toStrictEqual({ status: 200, body: "4" });
  });

  it("resolves a named import from the virtual module", async () => {
    // A module name that is not a path needs its type stated explicitly, which
    // is what `{ js }` is for. This is what lets the generated module keep a
    // greppable specifier instead of a filename.
    const stub = load("virtual-module", {
      "main.js": `
        import { add } from "opti:capabilities";
        export default { fetch() { return new Response(String(add(20, 22))) } }
      `,
      "opti:capabilities": { js: "export const add = (a, b) => a + b;" },
    });

    expect(await call(stub)).toStrictEqual({ status: 200, body: "42" });
  });

  it("gives the isolate no parent environment", async () => {
    const stub = load("no-env", {
      "main.js": `
        export default {
          fetch(request, env) { return new Response(JSON.stringify(Object.keys(env ?? {}))) }
        }
      `,
    });

    const { body } = await call(stub);

    // The host holds a LOADER binding. If the isolate could see it, sandboxed
    // code could load further isolates and the boundary is not a boundary.
    expect(JSON.parse(body)).toStrictEqual([]);
    expect(body).not.toContain("LOADER");
  });

  it("gives the isolate no parent environment through cloudflare:workers either", async () => {
    // The env argument is not the only way to reach bindings, so closing one
    // door is not the same as closing the room.
    const stub = load("no-env-builtin", {
      "main.js": `
        import { env } from "cloudflare:workers";
        export default { fetch() { return new Response(JSON.stringify(Object.keys(env ?? {}))) } }
      `,
    });

    expect(JSON.parse((await call(stub)).body)).toStrictEqual([]);
  });

  it("fails an ungranted import before any module body runs", async () => {
    const stub = load("ungranted", {
      "main.js": `
        import { add } from "opti:capabilities";
        import { decrypt } from "opti:secrets";
        export default { fetch() { return new Response(String(add(1, 1))) } }
      `,
      "opti:capabilities": { js: "export const add = (a, b) => a + b;" },
    });

    // A capability the caller was not granted must not fail halfway through a
    // run that has already had effects.
    await expect(call(stub)).rejects.toThrow();
  });

  it("survives a module that throws while loading", async () => {
    const stub = load("throws", { "main.js": 'throw new Error("boom at module scope")' });

    await expect(call(stub)).rejects.toThrow();

    // The host is still answering: a module that throws must not take the
    // server down with it.
    const survivor = load("throws-survivor", {
      "main.js": 'export default { fetch() { return new Response("still here") } }',
    });
    expect(await call(survivor)).toStrictEqual({ status: 200, body: "still here" });
  });

  // SPIKE FINDING, 2026-08-31. This is the one invariant the loader did NOT
  // deliver locally, so it is named here rather than left to be discovered.
  //
  // A module that busy-loops is not bounded by `limits: { cpuMs: 50 }` under
  // miniflare. workerd crashes, miniflare restarts it ("The Workers runtime
  // crashed unexpectedly and is being restarted"), and the vitest run never
  // terminates - where an ordinary run of this file takes about three seconds.
  // So locally, a module that loops forever DOES take the server down.
  //
  // Unskip when checking this against Cloudflare's loader on the paid plan.
  // Until something bounds it, the runaway backstop cannot be `limits` alone.
  it.skip("bounds a module that loops forever", async () => {
    const stub = env.LOADER.get("runaway", () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "main.js",
      limits: { cpuMs: 50 },
      modules: { "main.js": "export default { fetch() { while (true) {} } }" },
    }));

    await expect(stub.getEntrypoint().fetch("https://sandbox.invalid/")).rejects.toThrow();
  });

  it("reaches node: builtins even though the loaded worker set no compatibility flags", async () => {
    const stub = load("node-builtin", {
      "main.js": `
        import { Buffer } from "node:buffer";
        export default { fetch() { return new Response(typeof Buffer) } }
      `,
    });

    // Not an approval, a record. What the sandbox can import is a slice 1
    // deliverable, and this says the answer is wider than the module map alone.
    // If node: access is to be denied, denying it is work, not a default.
    expect((await call(stub)).body).toBe("function");
  });
});
