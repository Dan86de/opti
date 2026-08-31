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
- **Biome** for lint and format. `repos/**` is excluded.
- **effect-tsgo** for typecheck, in the editor and in CI, so an editor warning and a CI failure agree.
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
