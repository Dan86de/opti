import { defineProject } from "vitest/config";

/**
 * Pure logic only: envelope encoding, error tagging, and later placeholder
 * parsing and ranking. Nothing here may touch workerd - if a test needs the
 * runtime, it belongs in the workers project instead.
 */
export default defineProject({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
  },
});
