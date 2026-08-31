/**
 * The `execute` tool: a fresh isolate per run, driven through the MCP surface.
 *
 * This is where the Worker Loader spike's findings become behaviour. The
 * boundary under test is `globalOutbound: null` plus the absent parent
 * environment; the virtual module is a grant list, not a boundary. Most
 * assertions here are negative - the connection that was not made, the
 * environment that was not there, the isolate that was not shared - because
 * those are the invariants a later change would silently break.
 *
 * Local/production difference, recorded per the testing decisions: this runs
 * against miniflare's Worker Loader. The same file must pass against
 * Cloudflare's loader at the deploy step before the boundary claims are about
 * production.
 */
import { describe, expect, it } from "vitest";
import { add } from "../../src/registry/Registry.ts";
import { callTool, rpc } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

describe("the walking skeleton", () => {
  it("runs the worked example search hands out, and gets its answer", async () => {
    // The example is imported from the registry, not copied: this test is what
    // makes it a live fixture, so the code a model copies most literally
    // cannot go stale without failing here.
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, add.example.code);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: add.example.result } });
  });

  it("advertises exactly search and execute, still under the ceiling", async () => {
    const { accessToken } = await mintAccessToken();

    const listed = (await rpc(accessToken, "tools/list", {})) as { tools: { name: string }[] };

    // Two tools in Slice 1, three is the ceiling, a fourth is the tripwire.
    expect(listed.tools.map((tool) => tool.name).sort()).toStrictEqual(["execute", "search"]);
    expect(new TextEncoder().encode(JSON.stringify(listed)).length).toBeLessThanOrEqual(2048);
  });
});

describe("what goes wrong inside the module", () => {
  it("carries an uncaught throw's tag across the boundary intact", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `console.log("about to fail");
       export default async () => { throw { _tag: "QuotaExhausted", message: "no more" }; };`,
    );

    expect(result.isError).toBe(true);
    // Story 17: the boundary does not flatten what went wrong. The error also
    // brings the run's logs home, because a failure without its output is not
    // debuggable.
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "QuotaExhausted", message: "no more", retry: "never", logs: ["log: about to fail"] },
    });
  });

  it("carries a retry classification and an action across the boundary intact", async () => {
    const { accessToken } = await mintAccessToken();

    // The shape a Slice 2 gateway denial travels in: the capability wrapper
    // throws it inside the sandbox, and the approval link and the retry
    // classification must survive to the envelope, because a boundary that
    // flattens them deletes exactly what the denial exists to deliver.
    const result = await execute(
      accessToken,
      `export default async () => {
         throw {
           _tag: "HostNotApproved",
           message: "api.example is not approved for credential todoist",
           retry: "never",
           action: { kind: "approve-host", url: "https://opti.test/approve?credential=todoist&host=api.example" },
         };
       };`,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        tag: "HostNotApproved",
        retry: "never",
        action: { kind: "approve-host", url: "https://opti.test/approve?credential=todoist&host=api.example" },
      },
    });
  });

  it("keeps a retry of after when the thrown value said so", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `export default async () => { throw { _tag: "FetchBudgetExhausted", message: "resets at midnight UTC", retry: "after" }; };`,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "FetchBudgetExhausted", retry: "after" },
    });
  });

  it("names a plain Error by its name, not by Unexpected", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, 'export default async () => { throw new RangeError("too far"); };');

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "RangeError", message: "too far" },
    });
  });

  it("fails an ungranted import before any statement of the module runs", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { decrypt } from "opti:secrets";
       console.log("the module body ran");
       export default async () => decrypt("everything");`,
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { message: string; logs?: readonly string[] } }).error;
    expect(error.message).toContain("could not be loaded");
    // What must not have happened: no statement of the module ran, so nothing
    // was logged. Story 13 is exactly this - a capability that was not granted
    // fails at the import line, not halfway through a run with effects.
    expect(error.logs).toBeUndefined();
  });

  it("refuses a module without a default export, naming the contract", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, "export const nearly = 1;");

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "NoDefaultExport" },
    });
  });
});

describe("the boundary", () => {
  // Since Slice 2 the outbound is the gateway rather than null, so "lets
  // nothing out" became "everything that gets out went through the seam".
  // That boundary - fetch flowing through the gateway, sockets and node:net
  // still dead, the worker's own origin refused - lives in
  // gateway-seam.test.ts.

  it("does not share an isolate between two owners running identical code", async () => {
    // LOADER.get caches by name, and the tempting warm-start optimisation is
    // to name isolates after a hash of the code. This is the test that fails
    // on the day someone tries it: identical code, two owners, and the second
    // run must not see the first run's globals.
    const marker =
      "export default async () => { globalThis.runs = (globalThis.runs ?? 0) + 1; return globalThis.runs; };";
    const first = await mintAccessToken();
    const second = await mintAccessToken();

    const seenByFirst = await execute(first.accessToken, marker);
    const seenBySecond = await execute(second.accessToken, marker);

    expect(seenByFirst.structuredContent).toMatchObject({ ok: true, value: { result: 1 } });
    expect(seenBySecond.structuredContent).toMatchObject({ ok: true, value: { result: 1 } });
  });

  it("does not reuse an isolate even for the same owner", async () => {
    const marker =
      "export default async () => { globalThis.runs = (globalThis.runs ?? 0) + 1; return globalThis.runs; };";
    const { accessToken } = await mintAccessToken();

    await execute(accessToken, marker);
    const again = await execute(accessToken, marker);

    // A fresh isolate per run is what makes "a module that throws cannot
    // poison the next run" true without a cleanup step anywhere.
    expect(again.structuredContent).toMatchObject({ ok: true, value: { result: 1 } });
  });

  it("gives the module no parent environment to read", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { env } from "cloudflare:workers";
       export default async () => Object.keys(env ?? {});`,
    );

    // The host holds LOADER, KV and secrets. The sandbox must see none of
    // them - an empty object, not a filtered one.
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: [] } });
  });
});

describe("what comes home", () => {
  it("brings console output home, and only when there was any", async () => {
    const { accessToken } = await mintAccessToken();

    const chatty = await execute(
      accessToken,
      `export default async () => { console.log("step", 1); console.warn("careful"); return "done"; };`,
    );
    const quiet = await execute(accessToken, 'export default async () => "done";');

    expect(chatty.structuredContent).toMatchObject({
      ok: true,
      value: { result: "done", logs: ["log: step 1", "warn: careful"] },
    });
    // An absent field means the boring default: a run that logged nothing
    // carries no logs field at all.
    expect((quiet.structuredContent as { value: { logs?: unknown } }).value.logs).toBeUndefined();
  });

  it("truncates oversized logs and says what was dropped", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `export default async () => { for (let i = 0; i < 300; i++) console.log("line", i, "x".repeat(80)); return "ok"; };`,
    );

    const value = (result.structuredContent as { value: { result: string; logs: string[] } }).value;
    // The run succeeded: chattiness is not a failure.
    expect(value.result).toBe("ok");
    expect(JSON.stringify(value.logs).length).toBeLessThan(10_000);
    expect(value.logs.at(-1)).toContain("dropped");
  });

  it("fails an oversized result outright rather than truncating it", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, 'export default async () => "x".repeat(40_000);');

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "ResultTooLarge", retry: "never" },
    });
    // Never truncated also means never included: a result that cannot come
    // home whole does not come home at all.
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(4_000);
  });

  it("abandons a run that outlives the timeout, without claiming to have stopped it", async () => {
    const { accessToken } = await mintAccessToken();

    // The slow run waits on a timer rather than burning CPU: the recorded
    // spike finding is that a busy loop crashes workerd under miniflare, so
    // the host-side race is exercised with the slowness that stays runnable.
    const result = await execute(
      accessToken,
      "export default async () => new Promise((resolve) => setTimeout(resolve, 60_000));",
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "ExecutionTimedOut", retry: "never" },
    });
  }, 15_000);

  it("sees workerd itself refuse a run hung on a promise that can never settle", async () => {
    const { accessToken } = await mintAccessToken();

    // FINDING, 2026-08-31, local: a promise with no pending events behind it
    // does not sit until our timeout - workerd detects the hang and rejects
    // the call at once. Recorded here so nobody reads the host-side race as
    // the only thing standing between a hung run and a stuck request.
    const result = await execute(accessToken, "export default async () => new Promise(() => {});");

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "SandboxUnavailable" },
    });
  });
});
