import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { UPSTREAM_CLIENT_ID, UPSTREAM_CLIENT_SECRET, UPSTREAM_ORIGIN } from "./test/worker/support/upstream-address.ts";

/**
 * Anything touching workerd: the runner, the gateway, durable object storage,
 * and the absence of the parent environment.
 *
 * Local runs attach the real wrangler config rather than a stub, so a green run
 * here is not mistaken for proof of a boundary that local never had.
 *
 * The bindings below are added on top of it, and only here. They are the ones
 * that have no production counterpart yet: the KV namespace and the GitHub
 * application do not exist in the account, and putting placeholders in
 * `wrangler.jsonc` would break the deploy that runs on every push to main.
 * Nothing in `src` can tell the difference, because it reaches all of them
 * through the door.
 */
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          GITHUB_ORIGIN: UPSTREAM_ORIGIN,
          GITHUB_API_ORIGIN: UPSTREAM_ORIGIN,
          GITHUB_CLIENT_ID: UPSTREAM_CLIENT_ID,
          GITHUB_CLIENT_SECRET: UPSTREAM_CLIENT_SECRET,
          OWNER_ALLOWLIST: "github:4242, github:4243",
        },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["test/worker/**/*.test.ts"],
    // Both of these exist to be reached. The listener is what makes the egress
    // test's denial mean something; the doubled upstream is what lets the login
    // be driven end to end without a browser and without the real GitHub.
    globalSetup: ["./test/worker/support/listener.ts", "./test/worker/support/upstream.ts"],
  },
});
