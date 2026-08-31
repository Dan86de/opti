/**
 * The owner store, driven through its RPC surface the way the gateway, the
 * runner and the packages tool drive it. The negative assertions carry the
 * most: the draft `listPublished` did not return, the pointer a failed commit
 * did not move, the trail another run did not inherit.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../../src/packages/Manifest.ts";
import { storeFor } from "../../src/store/OwnerStore.ts";
import type { RunRecord, RunRecordInput } from "../../src/store/RunRecords.ts";
import { TRAIL_BOUND } from "../../src/store/RunRecords.ts";
import { LIST_BOUND } from "../../src/store/StorageData.ts";
import { mintedOwnerId } from "./support/token.ts";

const record = (runId: string, overrides?: Partial<RunRecordInput>): RunRecordInput => ({
  runId,
  createdAt: "2026-08-31T10:00:00.000Z",
  source: "execute",
  outcome: "success",
  code: "export default async () => 42;",
  envelopeJson: JSON.stringify({ ok: true, value: { runId, result: 42 } }),
  logs: [],
  timings: { totalMs: 12 },
  ...overrides,
});

/** Records cross the RPC boundary as JSON text; parse where the tests read. */
const getRun = async (
  store: { getRun(runId: string): Promise<string | null> },
  runId: string,
): Promise<RunRecord | null> => {
  const text = await store.getRun(runId);
  return text === null ? null : (JSON.parse(text) as RunRecord);
};

const manifest: Manifest = {
  summary: "Adds numbers.",
  exports: [{ name: "sum", signature: "sum(a: number, b: number): number" }],
};

describe("storage rows", () => {
  it("round-trips a value and scopes it to the owner", async () => {
    const mine = storeFor(env.OWNER_STORE, mintedOwnerId());
    const theirs = storeFor(env.OWNER_STORE, mintedOwnerId());

    await mine.storageSet("todo:last-sync", '{"at":"2026-08-31"}');

    expect(await mine.storageGet("todo:last-sync")).toBe('{"at":"2026-08-31"}');
    // The other owner's store is a different object entirely: the value that
    // must not be present over there never was.
    expect(await theirs.storageGet("todo:last-sync")).toBeNull();
  });

  it("deletes, and says whether there was anything to delete", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.storageSet("todo:x", "1");

    expect(await store.storageDelete("todo:x")).toBe(true);
    expect(await store.storageGet("todo:x")).toBeNull();
    expect(await store.storageDelete("todo:x")).toBe(false);
  });

  it("lists by prefix as a range, not as a LIKE pattern", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.storageSet("todo:1", "1");
    await store.storageSet("todo:2", "2");
    await store.storageSet("todos", "3");
    await store.storageSet("a_b", "4");
    await store.storageSet("axb", "5");

    // "todo:" is a prefix, so "todos" is out.
    expect(await store.storageList("todo:")).toStrictEqual({ keys: ["todo:1", "todo:2"] });
    // "_" is a literal underscore, never a single-character wildcard: the
    // key that must not be listed is "axb".
    expect(await store.storageList("a_")).toStrictEqual({ keys: ["a_b"] });
  });

  it("bounds the list and marks the cut", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    for (let i = 0; i < LIST_BOUND + 1; i++) {
      await store.storageSet(`k:${String(i).padStart(3, "0")}`, "1");
    }

    const listed = await store.storageList("k:");

    expect(listed.keys).toHaveLength(LIST_BOUND);
    expect(listed.truncated).toContain("narrow the prefix");
  });
});

describe("run records", () => {
  it("writes a record and reads it back whole", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());

    const verdict = await store.putRecord(record("run-1"));
    expect(verdict).toStrictEqual({ written: true });

    const read = await getRun(store, "run-1");
    expect(read).toMatchObject({
      runId: "run-1",
      source: "execute",
      outcome: "success",
      code: "export default async () => 42;",
      envelope: { ok: true, value: { runId: "run-1", result: 42 } },
      timings: { totalMs: 12 },
      trail: [],
    });
    expect(await getRun(store, "run-never")).toBeNull();
  });

  it("queries by time, source and outcome, newest first", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.putRecord(record("run-old", { createdAt: "2026-08-30T09:00:00.000Z" }));
    await store.putRecord(record("run-failed", { createdAt: "2026-08-31T09:00:00.000Z", outcome: "failure" }));
    await store.putRecord(record("run-new", { createdAt: "2026-08-31T11:00:00.000Z" }));

    const everything = await store.queryRuns({});
    expect(everything.map((run) => run.runId)).toStrictEqual(["run-new", "run-failed", "run-old"]);

    expect((await store.queryRuns({ outcome: "failure" })).map((run) => run.runId)).toStrictEqual(["run-failed"]);
    expect((await store.queryRuns({ since: "2026-08-31T00:00:00.000Z" })).map((run) => run.runId)).toStrictEqual([
      "run-new",
      "run-failed",
    ]);
    expect((await store.queryRuns({ until: "2026-08-30T23:59:59.000Z" })).map((run) => run.runId)).toStrictEqual([
      "run-old",
    ]);
    expect((await store.queryRuns({ limit: 1 })).map((run) => run.runId)).toStrictEqual(["run-new"]);
    // Summaries carry no code, no envelope, no logs: the query response is
    // paid for inside a result ceiling.
    expect(Object.keys(everything[0] ?? {}).sort()).toStrictEqual([
      "createdAt",
      "outcome",
      "runId",
      "source",
      "totalMs",
    ]);
  });

  it("attaches the buffered trail to its own run and to no other", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.appendTrail("run-a", { method: "GET", host: "api.example", status: 200, durationMs: 5 });
    await store.appendTrail("run-a", {
      method: "POST",
      host: "api.example",
      status: 403,
      durationMs: 2,
      denied: "HostNotApproved",
    });

    await store.putRecord(record("run-a"));
    await store.putRecord(record("run-b"));

    const a = await getRun(store, "run-a");
    expect(a?.trail).toStrictEqual([
      { method: "GET", host: "api.example", status: 200, durationMs: 5 },
      { method: "POST", host: "api.example", status: 403, durationMs: 2, denied: "HostNotApproved" },
    ]);
    // The buffer was consumed, not shared: the next record gets no trail.
    expect(await getRun(store, "run-b")).toMatchObject({ trail: [] });
  });

  it("bounds the trail and names what was dropped", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    for (let i = 0; i < TRAIL_BOUND + 3; i++) {
      await store.appendTrail("run-loop", { method: "GET", host: "api.example", status: 403, durationMs: 1 });
    }

    await store.putRecord(record("run-loop"));

    const read = await getRun(store, "run-loop");
    expect(read?.trail).toHaveLength(TRAIL_BOUND);
    expect(read?.trailTruncated).toContain("3 more requests dropped");
  });
});

describe("package state", () => {
  const files = [{ path: "index.ts", content: "export const sum = (a: number, b: number): number => a + b;\n" }];

  it("creates a draft that overview shows and listPublished does not", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());

    expect(await store.createPackage("sum", manifest, files)).toStrictEqual({ ok: true });

    expect(await store.packagesOverview()).toStrictEqual([
      { name: "sum", state: "draft", summary: "Adds numbers.", updatedAt: expect.any(String) },
    ]);
    // Publish is what makes a thing discoverable: the draft is findable
    // through read, and absent from what search and the module map consume.
    expect(await store.listPublished()).toStrictEqual([]);
  });

  it("refuses a second create under the same name", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.createPackage("sum", manifest, files);

    const verdict = await store.createPackage("sum", manifest, files);

    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).toContain("already exists");
  });

  it("publishes a snapshot, and an edit afterwards leaves it serving", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.createPackage("sum", manifest, files);
    const source = await store.publishSource("sum");

    const committed = await store.commitPublish("sum", source?.revision ?? -1, {
      "index.js": "export const sum = (a, b) => a + b;\n",
    });
    expect(committed).toStrictEqual({ ok: true });

    expect((await store.readPackage("sum"))?.state).toBe("published");
    await store.editPackageFile("sum", { path: "index.ts", content: "export const sum = () => 0;\n" });
    // Working state moved on; the published snapshot did not.
    expect((await store.readPackage("sum"))?.state).toBe("modified");
    expect(await store.listPublished()).toMatchObject([
      { name: "sum", entry: "index.js", files: { "index.js": "export const sum = (a, b) => a + b;\n" } },
    ]);
  });

  it("refuses a commit whose checks ran against an older revision", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.createPackage("sum", manifest, files);
    const source = await store.publishSource("sum");
    // The race: an edit lands while the publish checks run.
    await store.editPackageFile("sum", { path: "index.ts", content: "export const sum = () => 0;\n" });

    const committed = await store.commitPublish("sum", source?.revision ?? -1, { "index.js": "checked output" });

    expect(committed.ok).toBe(false);
    expect(JSON.stringify(committed)).toContain("edited while the publish checks ran");
    // The pointer did not move: nothing is published.
    expect(await store.listPublished()).toStrictEqual([]);
  });

  it("edits the manifest by halves, keeping the half that did not arrive", async () => {
    const store = storeFor(env.OWNER_STORE, mintedOwnerId());
    await store.createPackage("sum", manifest, files);

    await store.editPackageManifest("sum", { summary: "Adds two numbers together." });

    expect((await store.readPackage("sum"))?.manifest).toStrictEqual({
      summary: "Adds two numbers together.",
      exports: manifest.exports,
    });
  });
});
