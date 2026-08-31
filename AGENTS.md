# OPTI

An MCP server with exactly three tools: `search`, `execute`, `packages`.
Read `spec.md` first - it is the record, and anything not written there is not written down.

## Vendored repositories

This project vendors external repositories under `repos/` as squashed git subtrees.

- Use vendored repositories as read-only reference material when working with the related library.
- Prefer examples and patterns from the vendored source over generated guesses or web search results.
- Do not edit files under `repos/` unless explicitly asked.
- Do not import from `repos/`. Application code imports from normal package dependencies.

| Path | Upstream | Why it is here |
| --- | --- | --- |
| `repos/effect` | `Effect-TS/effect` @ `main` | Effect 4 is at RC, so the vendored source is the only complete documentation of the API we depend on. Also holds `packages/effect/src/unstable/ai/McpServer.ts` and the MCP test harnesses. |
| `repos/workers-oauth-provider` | `cloudflare/workers-oauth-provider` | Slice 1 is this library's job: OAuth in front of MCP, dynamic client registration, protected-resource metadata, audience checking. |
| `repos/workers-sdk` | `cloudflare/workers-sdk` | Ground truth for Worker Loader, miniflare and `vitest-pool-workers` when the published docs run out. |

Refresh them with `pnpm repos:sync`.

**Keep `repos/effect` on the same line as the `effect` dependency.**
Vendoring a branch that does not match the installed version is worse than not vendoring at all, because it feeds confident answers about an API that is not the one in `node_modules`.

## Toolchain

- **pnpm** workspaces. `repos/**` is excluded from the workspace; several vendored repos are themselves pnpm workspaces.
- **Effect 4** (`4.0.0-rc.112`). One package: `Schema`, `unstable/http` and `unstable/ai` all live inside `effect`. There is no `@effect/platform` on this line.
- **Biome** for lint and format. `repos/**` is excluded, and so is the generated `libs.generated.ts`.
- **effect-tsgo** for typecheck, in the editor and in CI, so an editor warning and a CI failure agree.
- **Two TypeScripts, on purpose.**
  The repository's own toolchain is the native TS7 line at the root.
  The publish pipeline needs a compiler that runs inside a Worker, and TS7 ships no JavaScript compiler API, so `@opti/server` depends on typescript 5.9 under the alias `in-worker-typescript`.
  The alias still links a `tsc` into the server's `.bin` that would shadow the root TS7, which is why the server's `typecheck` script invokes `../../node_modules/typescript/bin/tsc` by path.
- **Vitest**, two projects. Details below.

Commands: `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm dev`.

## Conventions

**Bindings arrive at the door.**
Nothing in the execute path reaches a binding from module scope.
Bindings are passed in as an explicit interface.
That single rule is what makes the eventual split into separate deployables a configuration change rather than surgery.

**The kernel has no implementation to hide.**
`src/kernel` holds the envelope and the error taxonomy.
Everything imports them; they import nothing but each other.

**An absent field means the boring default, so a present field is always a signal.**
Do not add a field to `Failure` that is set on every failure.

**Negative assertions name what must not have happened.**
The most valuable assertions here are the value that was not present, the request that was not made, the row that did not decrypt.
Write them so a later reader sees the invariant rather than inferring it.

## Tests

Two runners, and putting a test in the wrong one means it proved less than it looks like it proved.

- `packages/*/test/unit/` - plain vitest. Pure logic only: envelope encoding, error tagging, placeholder parsing, ranking.
- `packages/*/test/worker/` - `@cloudflare/vitest-pool-workers`. Anything touching workerd: the runner, the gateway, durable object storage, the absence of the parent environment.

Local development attaches every binding for real, including the loader and the gateway.
Write down every shortcut a non-production run takes, at the test, so the difference between local and production is visible rather than assumed.

## Deploying

Local and production only, and one deployable through slice 3.
There is no preview environment: per the spec it arrives with new durable object classes rather than transferred ones, so a preview can never reach production state.

Production deploys happen from CI on a push to `main`, gated behind the lint, typecheck and test job.
Nothing deploys off a red build.
The deploy needs two repository secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The deployed worker itself carries secrets set once with `wrangler secret put`, never through CI: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_ALLOWLIST` from Slice 1, and since Slice 2 `OPERATOR_TOKEN` (the admin routes) and `CREDENTIAL_KEY` (the vault cipher).
A deploy without the Slice 2 pair fails closed: the admin routes refuse everything, and the vault cannot decrypt.

`wrangler deploy` from a laptop is for checking something, not for shipping.
If a deploy did not come from `main`, the running code is not the code anyone can read.

## Worker Loader: what the spike established

Run on 2026-08-31 against miniflare's loader, in `packages/server/test/worker/loader.test.ts`, and confirmed as a binding on production.
What the spike left unanswered was closed in the Slice 1 interview on 2026-08-31 and is written up under Slice 1 in `spec.md`; this section is the evidence, that section is the work.
The spec names Worker Loader as the most load-bearing dependency in the system and as a recorded bet rather than an assumption, so this is the record of what it actually did.

The binding delivers what the platform choice was made for, on one binding:

| Field on `LOADER.get(name, () => ...)` | What it is for |
| --- | --- |
| `modules` | The virtual module map. Members resolve each other. |
| `env` | Omit it and the isolate receives no parent environment. |
| `globalOutbound` | The seam slice 2 replaces with the fetch gateway. `null` means no network. |
| `limits` | `{ cpuMs, subRequests }`. See the finding below before relying on it. |

Confirmed working locally: a fresh isolate boots; a named import resolves from the virtual module; the isolate sees no parent environment through either the `env` argument or `cloudflare:workers`; an ungranted import fails before any module body runs; a module that throws at load does not take the host down.

Two findings that change how code gets written:

**A module name that is not a path must state its type.**
`modules: { "opti:capabilities": "..." }` is rejected with *Module name must end with '.js' or '.py'*.
Use the object form, `{ js: "..." }`, which is what allows the virtual module to keep a greppable specifier instead of a filename.

**`limits.cpuMs` does not bound a busy loop locally, and the runtime crashes - but production bounds it.**
Locally, workerd crashes, miniflare restarts it, and the run never terminates: a module that loops forever *does* take the local server down, so the test stays skipped with this written on it.
On production, observed 2026-08-31 through a real MCP host driving the deployed runner, Cloudflare's loader rejects the call with *Worker exceeded CPU time limit.*, the invocation dies alone, and the host keeps serving.
The runner classifies that rejection as `CpuTimeExceeded`, retry `never`; see `rejectionFailure` in `src/runner/Runner.ts`.
The two environments disagree, and the disagreement itself is the recorded fact: never let a local run of a runaway "check" this again.

**The sandbox can import `node:` builtins** even when the loaded worker declares no compatibility flags.
What the sandbox can reach is therefore wider than the module map.
It is not narrowed, and per the Slice 1 decisions it does not need to be, because of the finding below.

**`globalOutbound: null` closes every way out at once.**
Established on 2026-08-31 in `packages/server/test/worker/sandbox-egress.test.ts`.
`fetch`, `cloudflare:sockets` `connect()` and `node:net.createConnection` are all refused with the same workerd message, and a listener on the other side records no connection; all three reach that listener when outbound is granted.
So the boundary is `globalOutbound` plus the absent `env`, the virtual module is a grant list rather than a boundary, and `node:` reachability is a fact to record rather than a hole to plug.
The test carries its own control on purpose: without something reachable to not reach, an egress test passes in an environment that has no network and proves nothing.

## The gateway seam: what Slice 2 established

Established on 2026-08-31, locally, in `packages/server/test/worker/gateway-seam.test.ts` and `gateway.test.ts`.
Confirmed on production the same day, through a real MCP host driving the deployed runner: a control fetch succeeded, `cloudflare:sockets` and `node:net` were both refused (Cloudflare's loader words it *proxy request failed, cannot connect to the specified address*), the own-origin fetch came back as the marked `OwnOriginRefused` denial - which is also the proof that the sealed props survive on the production loader - and the parent environment was still empty.

**`ctx.exports` loopback bindings are default-on** from compatibility date 2025-11-17, so the seam needs no compatibility flag.
The runner passes `ctx.exports.Gateway({ props: { ownerId, runId, origin } })` as the loaded isolate's `globalOutbound`, and the props arrive at the gateway intact - proved through behaviour (the own-origin refusal and per-owner policy), not through an echo endpoint.

**workerd routes a sandbox `connect()` to the outbound entrypoint's `connect()` method.**
The socket paths are dead not because a Fetcher cannot carry them but because `Gateway` deliberately defines no such method.
The day sockets are wanted, that method is the seam; until then its absence is the refusal.

**Redirect-following happens in the caller's own fetch machinery.**
The gateway fetches credentialed requests with `redirect: "manual"`, but a sandbox whose fetch defaults to `follow` re-issues the next hop itself - through the gateway again, where the new hop is scanned and policy-checked like any first request.
The invariant that holds is per-hop policy, not "the sandbox never sees a follow"; both halves are pinned in `gateway.test.ts`.

**Worker tests run one file at a time** (`fileParallelism: false` in `vitest.workers.config.ts`).
The listener double is shared state, and the assertions worth the most are "the wire stayed silent" counts, which a concurrent file's legitimate probes would falsify.

**The https-only rule has a config-borne exemption for tests.**
No local double can be https on port 443, so `GATEWAY_INSECURE_HOSTS` exempts the loopback listener in the test config, production pins it to the empty string in `wrangler.jsonc`, and the insecure-transport denial is proved against a non-exempt host.
An entry appearing in the production value is an alarm, not a feature.

## The owner store and the publish pipeline: what Slice 3 established

Established on 2026-08-31, locally, across `store.test.ts`, `storage.test.ts`, `records.test.ts` and `packages.test.ts`.
The same claims must be probed once against the deployed worker before they are about production; local and production have disagreed before.

**The trail is buffered in the owner store, not on the gateway instance - a recorded deviation from the interview's wording.**
The interview said "the per-run gateway instance buffers the trail", but workerd builds a fresh `WorkerEntrypoint` instance per call, so there is no per-run instance to buffer on.
The gateway appends each line to the owner store keyed by the run id from its props, and `putRecord` consumes the buffer in the same transaction that writes the record.
The buffer is bounded at 200 lines with a counted-drop marker, and orphaned buffers from hosts that died mid-run are swept a day later.

**workerd resolves module specifiers as paths against the referrer, bare names included.**
From `submitted.js` at the root, `opti:capabilities` resolves by exact name; from a module named `opti:packages/todoist/run.js`, the same specifier resolves to `opti:packages/todoist/opti:capabilities` and fails.
A leading slash is the depth-independent spelling of "from the root": `/opti:capabilities` resolves from any nesting, and `../../`-style traversal is plain path math that also works.
Publish therefore rewrites every `opti:` specifier in emitted package files to its `/`-prefixed form with a TypeScript emit transformer, and the generated package alias uses the same form.
Relative imports between a package's own files resolve inside the module map with no bundler, as the spec bet they would.

**The in-worker compiler runs, with three accommodations.**
typescript 5.9 lives under the `in-worker-typescript` alias (see Toolchain) and is imported dynamically together with the embedded libs, so only a publish pays their module-init cost and worker cold start does not.
The lib chain the compile checks against is `src/publish/libs.generated.ts`, generated by `scripts/generate-tslibs.mjs` and pinned to `node_modules` by a unit test, so upgrading the alias fails loudly until the script is re-run.
`ts.sys` probes bare Node builtins at module load, so `fs`, `os`, `path`, `perf_hooks`, `inspector` and `crypto` are aliased to deterministic shims in `src/publish/node-shims/` - in `wrangler.jsonc` for production and in `vitest.workers.config.ts` for the pool, the same map in both, so the two environments agree by construction.
The pool additionally pre-bundles the compiler (`deps.optimizer.ssr`), because vite's raw transform trips over a `sourceMappingURL` pointing at a map the package does not ship.

**`rootDir` is pinned in the publish compile.**
Without it, tsc emits relative to the computed common source directory, and a package whose files all share a subdirectory would silently lose that directory from its emitted paths.

**Run records cross the RPC boundary as JSON text.**
The workers RPC types reject `unknown`-typed fields wholesale and a recursive JSON type blows up their instantiation, so `putRecord` takes the envelope pre-serialized and `getRun` returns the whole record as text that callers splice onward or parse.

**A budget-refused execution gets no record.**
Records exist for runs, the execution counter moves at the door before a run boots, and a refusal at the door is not a run - so `ExecutionBudgetExhausted` is the one execute failure that carries no run id.
