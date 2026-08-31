/**
 * What exists, for a given owner.
 *
 * Built-in capabilities are a module in the bundle at this size, not a table.
 * This is the seam packages plug into in Slice 3: they will arrive as a second
 * source resolved per owner, ranked above these when both match.
 *
 * Everything a capability tells the model lives here in one place - summary,
 * signature, import line, tags, example - so what `search` says and what the
 * virtual module grants cannot drift apart: both read this record.
 */

import type { PackageExport } from "../packages/Manifest.ts";
import type { SandboxPackage } from "../runner/VirtualModule.ts";
import type { PublishedPackage } from "../store/PackageState.ts";

export interface Example {
  /** A complete module of the kind `execute` takes. */
  readonly code: string;
  /** What running it returns, so the example can be held to it by a test. */
  readonly result: unknown;
}

export interface Capability {
  readonly kind: "capability";
  readonly name: string;
  /** One line. The slim list is paid for on every conversation. */
  readonly summary: string;
  /** A TypeScript signature: the language the model is about to write in. */
  readonly signature: string;
  readonly importLine: string;
  /** The tags a call can raise. Shown in detail only. */
  readonly errorTags: readonly string[];
  /**
   * A worked example, shown in detail only. It is the part a model copies
   * most literally, which is why the runner's tests execute this exact code:
   * a stale example is worse than no example.
   */
  readonly example: Example;
  /**
   * The implementation, as the source the virtual module builder splices into
   * `opti:capabilities` when this capability is granted. Plain JavaScript: the
   * sandbox pays no compile step and models read it as-is.
   */
  readonly code: string;
}

/**
 * The wrapper is not decorative: a gateway denial travels as a synthetic
 * response marked `x-opti-failure: 1`, and this is what turns it into a
 * tagged throw the entry module already knows how to carry - tag, message,
 * retry and the approval action intact. Raw global `fetch` works too and
 * sees the marked response; the gateway, not this wrapper, is the boundary.
 */
const FETCH_CODE = `export const fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  if (response.headers.get("x-opti-failure") === "1") {
    const failure = await response.json();
    const denial = new Error(failure.message);
    denial._tag = failure.tag;
    denial.retry = failure.retry;
    if (failure.action !== undefined) denial.action = failure.action;
    throw denial;
  }
  return response;
};`;

export const fetchCapability: Capability = {
  kind: "capability",
  name: "fetch",
  summary:
    "HTTP to the outside world. Write {{credential:name}} where a saved credential's value goes; it is substituted outside the sandbox, only for hosts the owner approved.",
  signature: "fetch(input: string | Request, init?: RequestInit): Promise<Response>",
  importLine: 'import { fetch } from "opti:capabilities";',
  errorTags: ["UnknownCredential", "HostNotApproved", "InsecureTransport", "OwnOriginRefused", "FetchBudgetExhausted"],
  example: {
    // The endpoint is the unified /api/v1/ surface: the old REST v2 paths
    // answer 410 since 2026, observed against the live API on 2026-08-31,
    // and v1 responses are paginated ({ results, next_cursor }) rather than
    // a bare array.
    code:
      'import { fetch } from "opti:capabilities";\n' +
      "\n" +
      "// The credential's name goes where its value would; the value is\n" +
      "// substituted outside the sandbox and this code never holds it.\n" +
      "export default async () => {\n" +
      "  try {\n" +
      '    const response = await fetch("https://api.todoist.com/api/v1/projects", {\n' +
      '      headers: { authorization: "Bearer {{credential:todoist}}" },\n' +
      "    });\n" +
      "    // v1 responses are paginated: { results, next_cursor }.\n" +
      "    return { status: response.status };\n" +
      "  } catch (denial) {\n" +
      "    // A denial is typed and never worth retrying. Stop and hand the\n" +
      "    // human denial.message - and denial.action.url when present.\n" +
      "    return { stopped: denial._tag };\n" +
      "  }\n" +
      "};\n",
    // What this exact module returns for an owner with nothing saved, which
    // is every owner the first time: the denial that says to save first.
    result: { stopped: "UnknownCredential" },
  },
  code: FETCH_CODE,
};

/**
 * The internal-call helper each store-backed capability carries. Written out
 * per capability with a unique name on purpose: capability code strings are
 * joined into one module scope by the virtual module builder, so a shared
 * helper name would collide and a shared preamble would couple the grant
 * list's members to each other.
 */
const internalCall = (helper: string): string => `const ${helper} = async (path, body) => {
  const response = await globalThis.fetch("https://opti.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.headers.get("x-opti-failure") === "1") {
    const denial = new Error(payload.message);
    denial._tag = payload.tag;
    denial.retry = payload.retry;
    if (payload.action !== undefined) denial.action = payload.action;
    throw denial;
  }
  return payload;
};`;

const STORAGE_CODE = `${internalCall("storageCall")}
export const storage = {
  get: async (key) => (await storageCall("/storage/get", { key })).value,
  set: async (key, value) => { await storageCall("/storage/set", { key, value }); },
  delete: async (key) => (await storageCall("/storage/delete", { key })).deleted,
  list: (prefix) => storageCall("/storage/list", { prefix }),
};`;

export const storageCapability: Capability = {
  kind: "capability",
  name: "storage",
  summary:
    "Owner-scoped key-value state that survives across runs. The namespace is flat and shared by all your packages: prefix your keys.",
  signature:
    "storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; " +
    "delete(key: string): Promise<boolean>; list(prefix?: string): Promise<{ keys: string[]; truncated?: string }> }",
  importLine: 'import { storage } from "opti:capabilities";',
  errorTags: ["InvalidStorageKey", "StorageValueTooLarge", "FetchBudgetExhausted"],
  example: {
    code:
      'import { storage } from "opti:capabilities";\n' +
      "\n" +
      "// Keys match [a-z0-9:._-]+ and values are JSON. An oversized set\n" +
      "// fails outright; it is never truncated.\n" +
      "export default async () => {\n" +
      '  await storage.set("example:greeting", { hello: "world" });\n' +
      '  return await storage.get("example:greeting");\n' +
      "};\n",
    result: { hello: "world" },
  },
  code: STORAGE_CODE,
};

const RUNS_CODE = `${internalCall("runsCall")}
export const runs = {
  query: (filter) => runsCall("/runs/query", filter ?? {}),
  get: (runId) => runsCall("/runs/get", { runId }),
};`;

export const runsCapability: Capability = {
  kind: "capability",
  name: "runs",
  summary: "Query your past run records by time, source and outcome, or get one whole record by its run id.",
  signature:
    "runs: { query(filter?: { since?: string; until?: string; source?: string; " +
    'outcome?: "success" | "failure"; limit?: number }): ' +
    "Promise<{ runId: string; createdAt: string; source: string; outcome: string; totalMs: number }[]>; " +
    "get(runId: string): Promise<unknown> }",
  importLine: 'import { runs } from "opti:capabilities";',
  errorTags: ["NoSuchRun", "FetchBudgetExhausted"],
  example: {
    // Deterministic for a fresh owner - which is every owner the first time:
    // no run has failed yet, so the count is zero.
    code:
      'import { runs } from "opti:capabilities";\n' +
      "\n" +
      "export default async () => {\n" +
      '  const failed = await runs.query({ outcome: "failure" });\n' +
      "  return { failures: failed.length };\n" +
      "};\n",
    result: { failures: 0 },
  },
  code: RUNS_CODE,
};

export const add: Capability = {
  kind: "capability",
  name: "add",
  summary: "Add two numbers.",
  signature: "add(a: number, b: number): number",
  importLine: 'import { add } from "opti:capabilities";',
  errorTags: [],
  example: {
    code: 'import { add } from "opti:capabilities";\n\nexport default async () => add(20, 22);\n',
    result: 42,
  },
  code: "export const add = (a, b) => a + b;",
};

/** Every owner sees the built-ins; their published packages arrive beside
 * these, resolved per owner from the owner store. */
export const builtIns: readonly Capability[] = [add, fetchCapability, storageCapability, runsCapability];

/**
 * A published package as discovery sees it. The kind tag maps one-to-one to
 * the import the model writes: `opti:packages/<name>`, a namespace distinct
 * from `opti:capabilities`.
 */
export interface PackageEntry {
  readonly kind: "package";
  readonly name: string;
  readonly summary: string;
  readonly exports: readonly PackageExport[];
  readonly importLine: string;
}

/** One result set spans both sources, each entry saying which it is. */
export type Entry = Capability | PackageEntry;

export const packageEntry = (published: PublishedPackage): PackageEntry => ({
  kind: "package",
  name: published.name,
  summary: published.manifest.summary,
  exports: published.manifest.exports,
  importLine: `import { ${published.manifest.exports.map((declared) => declared.name).join(", ")} } from "opti:packages/${published.name}";`,
});

/** The same snapshots, shaped for the virtual module builder. */
export const sandboxPackages = (published: readonly PublishedPackage[]): readonly SandboxPackage[] =>
  published.map((pkg) => ({
    name: pkg.name,
    entry: pkg.entry,
    files: pkg.files,
    exportNames: pkg.manifest.exports.map((declared) => declared.name),
  }));
