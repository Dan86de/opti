/**
 * Run records, end to end: every execution writes one before responding,
 * every response carries the run id, and a failure is debuggable from its
 * record alone - the cause reconstructed without re-running, which is the
 * done-when's second half.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runsCapability } from "../../src/registry/Registry.ts";
import { storeFor } from "../../src/store/OwnerStore.ts";
import type { RunRecord } from "../../src/store/RunRecords.ts";
import { callTool } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

const recordFor = async (ownerId: string, runId: string): Promise<RunRecord | null> => {
  const text = await storeFor(env.OWNER_STORE, ownerId).getRun(runId);
  return text === null ? null : (JSON.parse(text) as RunRecord);
};

describe("every execution writes a record", () => {
  it("carries the run id on success, and the record matches what left", async () => {
    const { accessToken, ownerId } = await mintAccessToken();

    const code = 'export default async () => { console.log("working"); return 42; };';
    const result = await execute(accessToken, code);

    const value = (result.structuredContent as { value: { runId: string; result: number } }).value;
    expect(value.result).toBe(42);
    expect(value.runId).toMatch(/^[0-9a-f-]{36}$/);

    const record = await recordFor(ownerId, value.runId);
    expect(record).toMatchObject({
      runId: value.runId,
      source: "execute",
      outcome: "success",
      code,
      logs: ["log: working"],
      envelope: { ok: true, value: { result: 42 } },
    });
    // Written before the response left, so "that worked, save it" can name
    // this id immediately without racing the owner's own storage.
    expect(record?.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(record?.createdAt).toMatch(/Z$/);
  });

  it("carries the run id on failure too, with the tag intact in the record", async () => {
    const { accessToken, ownerId } = await mintAccessToken();

    const result = await execute(
      accessToken,
      'export default async () => { throw { _tag: "QuotaExhausted", message: "no more" }; };',
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { tag: string; runId: string } }).error;
    expect(error.tag).toBe("QuotaExhausted");
    expect(error.runId).toMatch(/^[0-9a-f-]{36}$/);

    const record = await recordFor(ownerId, error.runId);
    expect(record).toMatchObject({
      outcome: "failure",
      envelope: { ok: false, error: { tag: "QuotaExhausted", message: "no more" } },
    });
  });

  it("makes a failure debuggable from its record alone: which host, which status, in what order", async () => {
    const { accessToken, ownerId } = await mintAccessToken();

    // The failure class that actually happens: a fetch chain where one hop
    // is denied. The module even swallows the denial's message, so the
    // response alone cannot explain what happened - the record must.
    const result = await execute(
      accessToken,
      `import { fetch } from "opti:capabilities";
       export default async () => {
         try {
           await fetch("https://api.todoist.com/api/v1/projects", {
             headers: { authorization: "Bearer {{credential:todoist}}" },
           });
           return "reached";
         } catch {
           throw { _tag: "SyncFailed", message: "sync failed" };
         }
       };`,
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { runId: string } }).error;

    // Reconstruction, without re-running: the record's trail names the host,
    // the denial and the order, and the code names the request that made it.
    const record = await recordFor(ownerId, error.runId);
    expect(record?.trail).toStrictEqual([
      {
        method: "GET",
        host: "api.todoist.com",
        status: 403,
        durationMs: expect.any(Number),
        denied: "UnknownCredential",
      },
    ]);
    expect(record?.code).toContain("{{credential:todoist}}");
    // What must not be in a trail: bodies, values, or the placeholder text.
    expect(JSON.stringify(record?.trail)).not.toContain("credential:todoist");
  });

  it("returns the run's real result with an explicit marker when the record cannot be written", async () => {
    const { accessToken, ownerId } = await mintAccessToken();
    // Break the record table for this owner's live object: the run must
    // still answer, because the owner asked for the run, not the bookkeeping.
    await runInDurableObject(storeFor(env.OWNER_STORE, ownerId), (_instance, state) => {
      state.storage.sql.exec("DROP TABLE run_records");
    });

    const result = await execute(accessToken, 'export default async () => "the work itself";');

    expect(result.isError).toBeUndefined();
    const value = (result.structuredContent as { value: { result: string; unrecorded?: string } }).value;
    expect(value.result).toBe("the work itself");
    // The gap is visible rather than silent: no record exists, and the
    // response says so instead of failing a run whose side effects happened.
    expect(value.unrecorded).toContain("no run record exists");
  });
});

describe("the runs capability", () => {
  it("runs the worked example search hands out, and gets its answer", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, runsCapability.example.code);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: runsCapability.example.result } });
  });

  it("queries earlier runs and reads one whole record from inside a run", async () => {
    const { accessToken } = await mintAccessToken();

    const first = await execute(accessToken, "export default async () => 41;");
    const firstRunId = (first.structuredContent as { value: { runId: string } }).value.runId;

    const result = await execute(
      accessToken,
      `import { runs } from "opti:capabilities";
       export default async () => {
         const summaries = await runs.query({ source: "execute" });
         const record = await runs.get(${JSON.stringify(firstRunId)});
         return {
           seen: summaries.map((run) => run.runId),
           code: record.code,
           result: record.envelope.value.result,
         };
       };`,
    );

    const value = (result.structuredContent as { value: { result: { seen: string[]; code: string; result: number } } })
      .value;
    expect(value.result.seen).toContain(firstRunId);
    expect(value.result.code).toBe("export default async () => 41;");
    expect(value.result.result).toBe(41);
  });

  it("answers a run id nobody has with the typed refusal", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      `import { runs } from "opti:capabilities";
       export default async () => runs.get("run-that-never-was");`,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { tag: "NoSuchRun", retry: "never" },
    });
  });
});
