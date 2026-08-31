/**
 * What `require("crypto")` resolves to inside the worker bundle. The
 * compiler hashes files only for incremental builds and project references;
 * the publish compile uses neither, so an actual call failing loudly is the
 * honest answer.
 */
export const createHash = (): never => {
  throw new Error("crypto.createHash is not available inside the worker; the publish compile does not hash");
};
export default { createHash };
