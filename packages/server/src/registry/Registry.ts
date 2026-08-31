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

/** Every owner sees the built-ins; Slice 3 adds what is theirs on top. */
export const builtIns: readonly Capability[] = [add, fetchCapability];
