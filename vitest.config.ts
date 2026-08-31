import { defineConfig } from "vitest/config";

/**
 * Two runners, on purpose. Pure logic runs in plain vitest; anything that
 * touches workerd runs under the Workers pool. A test in the wrong project is a
 * test that proved less than it looks like it proved.
 */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.unit.config.ts", "packages/*/vitest.workers.config.ts"],
  },
});
