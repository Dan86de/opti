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
}

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
};

/** Every owner sees the built-ins; Slice 3 adds what is theirs on top. */
export const builtIns: readonly Capability[] = [add];
