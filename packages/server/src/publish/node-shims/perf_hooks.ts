/**
 * What `require("perf_hooks")` resolves to inside the worker bundle. The
 * compiler probes for Node's mark/measure surface, finds this is not it,
 * and falls back to its own wall-clock timestamps - which is the honest
 * behaviour on a runtime whose clock only advances on I/O anyway.
 */
export const performance = { now: (): number => Date.now() };
export class PerformanceObserver {
  observe(): void {}
  disconnect(): void {}
}
export default { performance, PerformanceObserver };
