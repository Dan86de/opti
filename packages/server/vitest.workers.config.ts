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
 * The bindings below are added on top of it, and only here. Two of them point
 * the upstream at the double; the rest are the deployed Worker's secrets, which
 * are not in the repository and so have to be supplied rather than overridden.
 * Nothing in `src` can tell the difference, because it reaches all of them
 * through the door.
 */
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Overridden to the double. If this override ever stops taking
          // effect, the identity tests reach the real github.com and fail
          // rather than quietly proving something else.
          GITHUB_ORIGIN: UPSTREAM_ORIGIN,
          GITHUB_API_ORIGIN: UPSTREAM_ORIGIN,
          // No production counterpart in the repo: these are secrets on the
          // deployed Worker, so there is nothing to override, only to supply.
          GITHUB_CLIENT_ID: UPSTREAM_CLIENT_ID,
          GITHUB_CLIENT_SECRET: UPSTREAM_CLIENT_SECRET,
          OWNER_ALLOWLIST: "github:4242, github:4243",
          // The vault's cipher secret, a worker secret in production.
          CREDENTIAL_KEY: "test-credential-key-with-enough-entropy",
          // The operator's token, a worker secret in production.
          OPERATOR_TOKEN: "test-operator-token",
          // Overridden down so the timeout test waits two seconds, not ten.
          // The hung run it abandons idles on a promise rather than burning
          // CPU, which under miniflare would crash workerd (the recorded
          // spike finding) instead of exercising the host-side race.
          EXECUTE_TIMEOUT_MS: "2000",
          // Overridden down so the budget tests trip real ceilings. Four
          // rather than the spec's two, because the deny-approve-succeed
          // journey itself spends three executions and three counted
          // fetches on one owner before anything is over budget.
          EXECUTION_BUDGET: "4",
          FETCH_BUDGET: "4",
          // The https-only exemption for the loopback listener; see the
          // comment in wrangler.jsonc. Production pins this empty.
          GATEWAY_INSECURE_HOSTS: "127.0.0.1",
        },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["test/worker/**/*.test.ts"],
    // One file at a time: the listener is shared state, and the assertions
    // worth the most here are "the wire stayed silent" counts, which a
    // concurrent file's legitimate probes would falsify.
    fileParallelism: false,
    // Both of these exist to be reached. The listener is what makes the egress
    // test's denial mean something; the doubled upstream is what lets the login
    // be driven end to end without a browser and without the real GitHub.
    globalSetup: ["./test/worker/support/listener.ts", "./test/worker/support/upstream.ts"],
  },
});
