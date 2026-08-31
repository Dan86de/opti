/**
 * What `require("path")` resolves to inside the worker bundle. The compiler
 * carries its own path logic for compilation; this covers the posix-shaped
 * calls `ts.sys` makes while initializing.
 */
export const sep = "/";
export const join = (...parts: string[]): string => parts.filter((part) => part.length > 0).join("/");
export const dirname = (path: string): string => {
  const cut = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return cut.length === 0 ? (path.startsWith("/") ? "/" : ".") : cut;
};
export const basename = (path: string): string => path.split("/").at(-1) ?? "";
export const resolve = (...parts: string[]): string => join(...parts);
export const normalize = (path: string): string => path;
export default { sep, join, dirname, basename, resolve, normalize };
