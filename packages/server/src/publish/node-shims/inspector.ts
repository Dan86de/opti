/**
 * What `require("inspector")` resolves to inside the worker bundle. Only the
 * CPU profiler path asks for it, checks for `Session`, and backs off when
 * there is none - which is exactly what happens here.
 */
export const Session = undefined;
export default { Session };
