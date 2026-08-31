/**
 * Where the doubled upstream lives.
 *
 * Its own module for the same reason as the listener's: the double runs in node
 * and this constant is read from workerd and from the vitest config, so it must
 * not drag `node:http` along with it.
 */
export const UPSTREAM_HOST = "127.0.0.1";
export const UPSTREAM_PORT = 43198;
export const UPSTREAM_ORIGIN = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

/** What the double is configured to accept. Production values are real secrets. */
export const UPSTREAM_CLIENT_ID = "test-client-id";
export const UPSTREAM_CLIENT_SECRET = "test-client-secret";

/**
 * An authorization code stands for a user, so the double encodes the user in
 * the code rather than holding configuration a test has to set up and tear
 * down. Tests therefore never share mutable state with each other.
 */
export const authorizationCode = (subject: string, login: string) => `code:${subject}:${login}`;

/** Who the doubled upstream is always already signed in as. */
export const SIGNED_IN = { subject: "4242", login: "allowlisted-owner" };
