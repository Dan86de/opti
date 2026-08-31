/**
 * What `require("fs")` resolves to inside the worker bundle.
 *
 * The publish compile runs the TypeScript compiler over a virtual file
 * system through a full CompilerHost, so nothing should ever read the real
 * one - but `ts.sys` initializes at module load and touches these members.
 * Present members answer "nothing exists here"; anything that would actually
 * read or write throws by name, so an unexpected use fails loudly instead of
 * quietly seeing an empty world.
 */
const refuse = (name: string) => (): never => {
  throw new Error(`fs.${name} is not available inside the worker; the publish compile is virtual`);
};

export const realpathSync = Object.assign((path: string): string => path, {
  native: (path: string): string => path,
});
export const statSync = (_path: string, _options?: unknown): undefined => undefined;
export const lstatSync = (_path: string, _options?: unknown): undefined => undefined;
export const existsSync = (): boolean => false;
export const readFileSync = refuse("readFileSync");
export const writeFileSync = refuse("writeFileSync");
export const readdirSync = (): never[] => [];
export const mkdirSync = refuse("mkdirSync");
export const unlinkSync = refuse("unlinkSync");
export const openSync = refuse("openSync");
export const closeSync = refuse("closeSync");
export const watch = refuse("watch");
export const watchFile = refuse("watchFile");
export const unwatchFile = refuse("unwatchFile");
export default {
  realpathSync,
  statSync,
  lstatSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  watch,
  watchFile,
  unwatchFile,
};
