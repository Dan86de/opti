/**
 * Discovery: query in, slim or detail out.
 *
 * The three modes are one argument apart. `search({ query })` filters the slim
 * list, `search({ name })` returns detail for one entry, `search({})` returns
 * everything ranked - so asking for the full list needs no third mode.
 *
 * Everything expensive is detail-only. The slim response is paid on every
 * turn, so it carries a name, a summary and a TypeScript signature and nothing
 * else; error tags and the worked example arrive only when asked for by name.
 *
 * Ranking is lexical only, per the spec, until three real queries have failed
 * on it.
 */
import { Data, Effect, Schema } from "effect";
import type { Failure } from "../kernel/index.ts";
import type { Capability } from "../registry/Registry.ts";

/** No entry under that name. Retrying the same name cannot help. */
export class NoSuchCapability extends Data.TaggedError("NoSuchCapability")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * More entries matched than the response carries. A silently cut list teaches
 * a model that the missing thing does not exist, so the cut announces itself.
 */
const BOUND = 10;

export interface SlimEntry {
  readonly kind: "capability";
  readonly name: string;
  readonly summary: string;
  readonly signature: string;
}

export interface SlimResponse {
  readonly results: readonly SlimEntry[];
  /** Present only when the list was cut. Names what was dropped. */
  readonly truncated?: string;
  /** Present only when nothing matched. Names what does exist. */
  readonly hint?: string;
}

const slim = (capability: Capability): SlimEntry => ({
  kind: capability.kind,
  name: capability.name,
  summary: capability.summary,
  signature: capability.signature,
});

/**
 * Lexical score of one entry against one query. Exact name beats a name
 * fragment beats a summary word, so `add` outranks something that merely
 * mentions adding - and an entry that matches nothing scores zero and is out.
 */
const score = (capability: Capability, tokens: readonly string[]): number => {
  let total = 0;
  const name = capability.name.toLowerCase();
  const prose = `${capability.summary} ${capability.signature}`.toLowerCase();
  for (const token of tokens) {
    if (token === name) {
      total += 100;
    } else if (name.includes(token)) {
      total += 40;
    }
    if (prose.includes(token)) {
      total += 10;
    }
  }
  return total;
};

const tokenize = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length > 0);

/**
 * The slim list for a query, ranked, bounded, and never silently empty.
 * Exported for the unit tests: ranking and bounding are pure logic.
 */
export const slimList = (available: readonly Capability[], query: string | undefined): SlimResponse => {
  const tokens = query === undefined ? [] : tokenize(query);
  const matched =
    tokens.length === 0
      ? [...available]
      : available
          .map((capability) => ({ capability, points: score(capability, tokens) }))
          .filter((entry) => entry.points > 0)
          .sort((a, b) => b.points - a.points || a.capability.name.localeCompare(b.capability.name))
          .map((entry) => entry.capability);

  if (matched.length === 0) {
    return {
      results: [],
      hint: `nothing matched. What exists: ${available.map((capability) => capability.name).join(", ")}`,
    };
  }
  const results = matched.slice(0, BOUND).map(slim);
  return matched.length > results.length
    ? { results, truncated: `${matched.length - results.length} more matched; narrow the query` }
    : { results };
};

/** Detail is the whole record: the signature, the tags, the worked example. */
export const detail = (available: readonly Capability[], name: string): Effect.Effect<Capability, NoSuchCapability> => {
  const found = available.find((capability) => capability.name === name);
  return found === undefined
    ? Effect.fail(
        new NoSuchCapability({
          message: `nothing is named ${name}. What exists: ${available.map((capability) => capability.name).join(", ")}`,
        }),
      )
    : Effect.succeed(found);
};

export const parameters = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

/** The tool, minus its owner-bound wiring: the entry point serves this. */
export const tool = {
  name: "search",
  description:
    "Find what this server can do. No arguments: everything, ranked. " +
    "{query}: filter it. {name}: full detail for one entry - types, error tags, a worked example. " +
    "Signatures are TypeScript, for the code execute runs.",
  parametersSchema: parameters,
};

export const run = (
  available: readonly Capability[],
  input: typeof parameters.Type,
): Effect.Effect<SlimResponse | Capability, NoSuchCapability> =>
  "name" in input ? detail(available, input.name) : Effect.succeed(slimList(available, input.query));
