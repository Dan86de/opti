/**
 * Envelope-side redaction: before the envelope leaves the execute path,
 * result, logs and failure messages are scanned for the owner's credential
 * values, and each hit becomes `[redacted:name]`.
 *
 * All of the owner's values are scanned rather than tracking which ones a
 * run touched, which keeps redaction stateless; the surfaces are already
 * serialized and bounded. This lives in the gateway module because the
 * gateway module is the one place plaintext is materialized, and a choke
 * point is a module, not a function.
 *
 * The scan catches raw values only. A derived encoding - base64 of
 * user:pass in a Basic header - slips past it, per the accepted residual;
 * the trigger for an opaque header helper is the first credential actually
 * used that way.
 */

/** Longest value first, so one value containing another redacts whole. */
const byLength = (values: Readonly<Record<string, string>>): readonly [string, string][] =>
  Object.entries(values).sort((a, b) => b[1].length - a[1].length);

export const redactText = (values: Readonly<Record<string, string>>, text: string): string => {
  let redacted = text;
  for (const [name, value] of byLength(values)) {
    if (value.length > 0) {
      redacted = redacted.split(value).join(`[redacted:${name}]`);
    }
  }
  return redacted;
};

/**
 * Walk a JSON-shaped value and redact every string in it, keys included,
 * because an API that echoes a credential does not ask where to put it.
 */
export const redactValue = (values: Readonly<Record<string, string>>, subject: unknown): unknown => {
  if (typeof subject === "string") {
    return redactText(values, subject);
  }
  if (Array.isArray(subject)) {
    return subject.map((entry) => redactValue(values, entry));
  }
  if (subject !== null && typeof subject === "object") {
    return Object.fromEntries(
      Object.entries(subject).map(([key, entry]) => [redactText(values, key), redactValue(values, entry)]),
    );
  }
  return subject;
};
