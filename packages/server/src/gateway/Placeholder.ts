/**
 * The placeholder protocol: `{{credential:name}}`, names `[a-z0-9._-]+`.
 *
 * A textual protocol, not an API: the scan runs uniformly across the URL, the
 * header values and a text body of the final serialized request, so a
 * placeholder assembled by concatenation still resolves. The order is scan,
 * then policy, then substitute - substitution never happens here without the
 * caller having resolved every scanned name first.
 *
 * There is no escape hatch for sending the literal text `{{credential:x}}`
 * unresolved; the trigger to add one is the first run that genuinely needs to
 * transmit it.
 */

/** What may name a credential. Anything else is literal text, not a name. */
export const NAME_PATTERN = /^[a-z0-9._-]+$/;

const PLACEHOLDER = /\{\{credential:([a-z0-9._-]+)\}\}/g;

/**
 * Every credential name the given pieces of a request mention, deduplicated.
 * A request naming two credentials needs both resolved, which is why the scan
 * answers with names rather than positions.
 */
export const scan = (parts: readonly string[]): readonly string[] => {
  const names = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(PLACEHOLDER)) {
      names.add(match[1] as string);
    }
  }
  return [...names];
};

/**
 * Replace every placeholder whose name the map holds. The gateway resolves
 * all scanned names before calling this, so a placeholder this leaves behind
 * is a bug upstream, not a feature here.
 */
export const substitute = (text: string, values: ReadonlyMap<string, string>): string =>
  text.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole);
