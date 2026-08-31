/**
 * Escaping for the pages a person sees.
 *
 * One escaper, and it is the attribute-safe one. A text-only escaper alongside
 * it would eventually be used in an attribute by somebody who did not check
 * which was which, and the failure would be silent.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
