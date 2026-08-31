import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/**
 * Anything touching workerd: the runner, the gateway, durable object storage,
 * and the absence of the parent environment.
 *
 * Local runs attach the real wrangler config rather than a stub, so a green run
 * here is not mistaken for proof of a boundary that local never had.
 */
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    name: "workers",
    include: ["test/worker/**/*.test.ts"],
  },
});
