/**
 * What `require("os")` resolves to inside the worker bundle; see
 * `node-shims/README.md` in this directory's docblocks: the in-worker
 * compiler probes Node builtins at module init, and these shims make that
 * init deterministic and identical between the test pool and production.
 */
export const platform = (): string => "linux";
export const EOL = "\n";
export default { platform, EOL };
