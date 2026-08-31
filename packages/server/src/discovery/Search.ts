/**
 * Discovery: query in, slim or detail out.
 *
 * The three modes are one argument apart. `search({ query })` filters the slim
 * list, `search({ name })` returns detail for one entry, `search({})` returns
 * everything ranked - so asking for the full list needs no third mode.
 *
 * Results span capabilities and the owner's published packages in one set,
 * each entry tagged with which it is because the import path differs.
 * Package-above-capability is a tie-break on equal score, not an additive
 * bonus: a weak package match must not outrank a strong primitive match.
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
import type { Capability, Entry, PackageEntry } from "../registry/Registry.ts";
import type { CredentialMetadata } from "../vault/OwnerVault.ts";

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
  readonly kind: "capability" | "package";
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

/** A package's one-line signature is its declared exports, joined: the slim
 * list has one signature column whichever kind the entry is. */
const signatureOf = (entry: Entry): string =>
  entry.kind === "capability" ? entry.signature : entry.exports.map((declared) => declared.signature).join("; ");

const slim = (entry: Entry): SlimEntry => ({
  kind: entry.kind,
  name: entry.name,
  summary: entry.summary,
  signature: signatureOf(entry),
});

/**
 * Lexical score of one entry against one query. Exact name beats a name
 * fragment beats a summary word, so `add` outranks something that merely
 * mentions adding - and an entry that matches nothing scores zero and is out.
 */
const score = (entry: Entry, tokens: readonly string[]): number => {
  let total = 0;
  const name = entry.name.toLowerCase();
  const prose = `${entry.summary} ${signatureOf(entry)}`.toLowerCase();
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

/** The tie-break: what you proved outranks a general primitive - when both
 * match equally, and only then. */
const kindRank = (entry: Entry): number => (entry.kind === "package" ? 0 : 1);

const byRank = (a: { entry: Entry; points: number }, b: { entry: Entry; points: number }): number =>
  b.points - a.points || kindRank(a.entry) - kindRank(b.entry) || a.entry.name.localeCompare(b.entry.name);

const tokenize = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length > 0);

/**
 * The slim list for a query, ranked, bounded, and never silently empty.
 * Exported for the unit tests: ranking and bounding are pure logic.
 */
export const slimList = (available: readonly Entry[], query: string | undefined): SlimResponse => {
  const tokens = query === undefined ? [] : tokenize(query);
  const matched = available
    .map((entry) => ({ entry, points: tokens.length === 0 ? 0 : score(entry, tokens) }))
    .filter((scored) => tokens.length === 0 || scored.points > 0)
    .sort(byRank)
    .map((scored) => scored.entry);

  if (matched.length === 0) {
    return {
      results: [],
      hint: `nothing matched. What exists: ${available.map((entry) => entry.name).join(", ")}`,
    };
  }
  const results = matched.slice(0, BOUND).map(slim);
  return matched.length > results.length
    ? { results, truncated: `${matched.length - results.length} more matched; narrow the query` }
    : { results };
};

/**
 * How credentials appear anywhere in discovery: names and approved hosts,
 * never values. One line per credential, already prose, so both users of it
 * - the fetch detail and the empty-result hint - say it the same way.
 */
const describeCredentials = (credentials: readonly CredentialMetadata[]): string =>
  credentials.length === 0
    ? "no credentials are saved yet"
    : `saved credentials: ${credentials
        .map(
          (entry) =>
            `${entry.name} (approved for: ${entry.hosts.length === 0 ? "no hosts yet" : entry.hosts.join(", ")})`,
        )
        .join("; ")}`;

/** Detail is the whole record. For `fetch` it also carries the owner's saved
 * credential names with their approved hosts - the moment of need is before
 * code is written, which makes this a search-time answer and not a runtime
 * capability. For a package it is the manifest: exports and the import line. */
export type DetailResponse = (Capability | PackageEntry) & {
  readonly credentials?: readonly CredentialMetadata[];
};

export const detail = (
  available: readonly Entry[],
  credentials: Effect.Effect<readonly CredentialMetadata[]>,
  name: string,
): Effect.Effect<DetailResponse, NoSuchCapability> => {
  const found = available.find((entry) => entry.name === name);
  if (found === undefined) {
    return Effect.fail(
      new NoSuchCapability({
        message: `nothing is named ${name}. What exists: ${available.map((entry) => entry.name).join(", ")}`,
      }),
    );
  }
  if (found.kind !== "capability" || found.name !== "fetch") {
    return Effect.succeed(found);
  }
  // The one per-owner detail response beyond packages themselves; the slim
  // list and tools/list stay static and stay under their ceiling.
  return credentials.pipe(Effect.map((saved): DetailResponse => ({ ...found, credentials: saved })));
};

export const parameters = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

/** The tool, minus its owner-bound wiring: the entry point serves this. */
export const tool = {
  name: "search",
  description:
    "Find what this server can do: capabilities, and your published packages. No arguments: everything, ranked. " +
    "{query}: filter it. {name}: full detail for one entry - types, error tags, a worked example. " +
    "Signatures are TypeScript, for the code execute runs.",
  parametersSchema: parameters,
};

export const run = (
  entries: Effect.Effect<readonly Entry[]>,
  credentials: Effect.Effect<readonly CredentialMetadata[]>,
  input: typeof parameters.Type,
): Effect.Effect<SlimResponse | DetailResponse, NoSuchCapability> =>
  entries.pipe(
    Effect.flatMap((available): Effect.Effect<SlimResponse | DetailResponse, NoSuchCapability> => {
      if ("name" in input) {
        return detail(available, credentials, input.name);
      }
      const slim = slimList(available, input.query);
      if (slim.results.length > 0) {
        return Effect.succeed(slim);
      }
      // An empty result is exactly the moment a missing capability should read
      // as a starting point: name the primitives that exist, and the saved
      // credentials with their approved hosts - names and hosts only, never
      // values - so the agent knows what fetch can already reach.
      return credentials.pipe(
        Effect.map((saved) => ({
          ...slim,
          hint: `${slim.hint ?? "nothing matched"}. Also: ${describeCredentials(saved)}`,
        })),
      );
    }),
  );
