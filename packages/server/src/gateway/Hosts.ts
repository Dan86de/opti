/**
 * Host matching for the credential allowlist.
 *
 * An allowlist entry is an exact hostname, compared case-insensitively
 * against the hostname of the final request; no scheme, no port, no path,
 * and no wildcards. A wildcard is accumulation wearing a decision's
 * paperwork, and approving a second host is one operator command.
 */

/** Does the allowlist name this exact hostname? */
export const hostApproved = (approved: readonly string[], hostname: string): boolean => {
  const wanted = hostname.toLowerCase();
  return approved.some((entry) => entry.toLowerCase() === wanted);
};

/**
 * A placeholder-bearing request must be https on the default port, whatever
 * the allowlist says. `url.port` is empty exactly when the port is the
 * scheme's default, which for https is 443.
 */
export const isSecureTransport = (url: URL): boolean => url.protocol === "https:" && url.port === "";

/**
 * Hosts exempt from the secure-transport rule, from configuration.
 *
 * SHORTCUT, and the whole reason this function exists: the automated
 * done-when drives a substituted request into the listener double, which
 * lives on plain http on a loopback port and can never satisfy the https
 * rule. The exemption arrives through the bindings like every other
 * local/production difference, the production value is pinned empty in
 * wrangler.jsonc, and an entry appearing there is an alarm, not a feature.
 */
export const exemptFromSecureTransport = (exemptHosts: string, hostname: string): boolean =>
  exemptHosts
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .includes(hostname.toLowerCase());
