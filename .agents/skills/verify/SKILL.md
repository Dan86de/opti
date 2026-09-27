---
name: verify
description: Start a local, isolated OPTI (the worker under wrangler dev plus a GitHub stand-in), drive it the way an MCP host and the operator do, and record whether each check passed in an evidence.md. Use it on your own, before calling any change to OPTI's behaviour done, instead of asking the user to check.
---

# verify

OPTI is an MCP server.
The surface a user touches most is `POST /mcp`, the JSON-RPC endpoint an MCP host calls with an OAuth bearer token, serving exactly three tools: `search`, `execute`, `packages`.
The other surfaces are the OAuth login pages a person sees once (`/authorize`, `/callback/github`), the approval landing page (`/approve`), the operator command (`scripts/operator.sh`, calling `/admin/*`), and `GET /health`.

What the product should do, step by step, is the feature map in [docs/manual/](../../../docs/manual/README.md).
This skill is how to run it; the map is what to check.
Read the map's README before your first run.

Everything below runs from the repository root through one helper:

```bash
.agents/skills/verify/opti-verify.mjs help
```

Every helper call is appended to `.scratch/verify/<run>/transcript.log` with its exact command line, everything it printed, and its exit code, refusals included.
Copy evidence from there; do not paraphrase it.

## Start

```bash
.agents/skills/verify/opti-verify.mjs start
```

It prints the run id, the run folder `.scratch/verify/<run>/` (`<run>` is a UTC timestamp plus six random hex characters), the origin, and both pids.
The ready signal is its last line: `ready: GET /health answered {"ok":true,"value":{"service":"opti"}}, and the GitHub stand-in answers`.
A start that prints `NOT READY` names which of the two did not answer, shows its log, and exits 1; stop that run before starting another.
`start` also creates an empty `<run folder>/modules/` for the files you drive with.

What a run gets, all inside its folder:

- Its own free ports for the worker, the devtools inspector and the GitHub stand-in, all on 127.0.0.1.
- Its own state: `wrangler dev --persist-to <run>/state`, so KV, both durable objects and traces start empty and nothing touches `packages/server/.wrangler/state`.
- Its own secrets in `<run>/secrets.env`, verify-only values, loaded with `--env-file` so a `.dev.vars` file is never read.
- Its own `HOME` (`<run>/home`) and a scrubbed environment, so the user's wrangler login and `CLOUDFLARE_*` settings never reach it. `--local` keeps every binding local.
- The GitHub stand-in: the worker tests' own double (`packages/server/test/worker/support/upstream.ts`), always signed in as `github:4242`, which is the run's only allowlisted owner. It stands where production has the real GitHub login, which no check here is about.
- Logs: `dev.log` (wrangler and workerd) and `github-double.log`.

Two runs can go side by side, and a run can go beside `pnpm test`.

What a run cannot reach, and so never checks:

- **The vault capability.** The vault container is started with `--enable-containers=false`: it needs `OBSIDIAN_AUTH_TOKEN` and `OBSIDIAN_SYNC_CONFIG`, and it would sync the owner's real vault. Vault calls in a run fail with `VaultUnavailable`. Vault checks are `not driven`.
- **Production.** No deploy, no `wrangler secret`, no `--remote`, no `wrangler tail`. The helper refuses `deploy`, `secret`, `remote` and `tail` outright, and never takes an origin: it only talks to the run's own worker.
- **The real GitHub login and a real MCP host.** Login is driven against the stand-in, as a host would drive it; the host's own UI is not.
- **Production-only runtime behaviour.** A CPU-bound runaway module crashes local workerd instead of being cut off, while production cuts it off with `CpuTimeExceeded`. Never execute one in a run.

The helper refuses to drive any run it did not start, and any run whose wrangler process is gone or belongs to another folder.

## Doctor

```bash
.agents/skills/verify/opti-verify.mjs doctor <run>
```

Read-only.
It checks that the wrangler and stand-in pids are alive and were started for this run folder, that the run's port is served by the run's own process tree, that `/health` answers as opti, that `packages/server/src` and `wrangler.jsonc` are unchanged since start (the current build), and, after `login`, that the run's token is accepted on `tools/list`.
It ends in `FIT: this instance is worth driving.` (exit 0) or `UNFIT: n problem(s) above.` (exit 1).

Run it first, after `login`, and again whenever something looks off.
A doctor that says the source changed means the worker you are driving may not be the code you are checking: stop the run and start a new one.

Never drive an instance doctor calls `UNFIT`, and never work around one by starting or stopping anything by hand: a check driven on an unfit instance is not evidence.
Stop the run and start a fresh one.
If a fresh run is `UNFIT` too, the harness itself is broken: fix `opti-verify.mjs` (and this skill, if it was wrong) or report it, and write the run's verdict as **Not done** with every check `not driven`.

## Drive

Sign in first; every MCP call needs the token this saves to `<run>/access-token`:

```bash
.agents/skills/verify/opti-verify.mjs login <run>
```

It walks the whole host login and prints each hop: the 401 and its `www-authenticate`, both metadata documents, dynamic registration, the consent page (saved to `<run>/consent.html`), the button's POST, the stand-in, the callback, and the token exchange.
It ends with `signed in as github:4242`.

Then drive with these, taking every command and handle from the map:

| Command | What it does | Exit code |
| --- | --- | --- |
| `tool <run> <search\|execute\|packages> [json\|@file]` | `tools/call`; prints `envelope: ok` or `envelope: failure <Tag> (retry <r>)`, then the envelope | 0 ok, 2 failure envelope, 1 transport or JSON-RPC error |
| `exec <run> <file.js>` | `execute` with the file as `code` | 0 ok, 2 failure envelope, 1 transport or JSON-RPC error |
| `mcp <run> <method> [params\|@file]` | any JSON-RPC method on `/mcp`, e.g. `initialize`, `tools/list` | 0 on HTTP 200 |
| `http <run> <METHOD> </path> [body\|@file]` | any other route, without a token: `/approve`, `/health`, `/admin/*` | 0 |
| `operator <run> approve-host\|save-credential ...` | runs `scripts/operator.sh` against this run with the run's operator token; `save-credential` reads the value from `OPTI_CREDENTIAL_VALUE`; prints the script's output and `operator.sh exit <n>` | 0 when the script exits 0, else 1 |

Any helper command that refuses prints `REFUSED: <why>` and `Nothing was changed.` and exits 3.

Write modules and JSON arguments as files under `<run>/modules/` and pass them as `@<path>` or to `exec`, so the evidence can point at them.

Read what a step left behind with `inspect`, which is read-only and refuses anything that writes:

| Command | Reads |
| --- | --- |
| `inspect <run> kv [prefix]` | `OAUTH_KV` keys; identity mappings in full, everything else as a length |
| `inspect <run> store "<SELECT ...>"` | the signed-in owner's `OwnerStore` SQLite: `run_records`, `packages`, `package_files`, `storage_data`, `trail_buffer`; prints the statement, then `columns` and `rows` as JSON |
| `inspect <run> vault [needle]` | the owner's `OwnerVault` keys and sizes, and whether each value contains `needle` |
| `inspect <run> logs ["<SELECT ...>"]` | the run's captured traces and console logs (`logs` and `spans` tables) |

For the pages a person looks at, the consent screen, `/approve` and the sign-in problem page, also open them in the browser pane at the run's origin, in light and dark, and look: readable text, no scrollbar, nothing split or overflowing.
The browser pane cannot save a screenshot into the run folder, so for these checks `Captured` says what each screenshot showed, and the page's text comes from `verify http <run> GET <path>`, which lands in the transcript.

## Evidence

`start` writes `<run>/evidence.md` with the commit, the branch, whether there were uncommitted changes, a `## Verdict` placeholder and an empty `## Checks` heading.
Replace the placeholder with the verdict in bold, and put every section below under `## Checks`:

- First `### Setup - start, doctor, login, doctor`, holding those four commands and their output.
- Then one section per map step and per `Behind it` line, in the shape below.
- Last `### Teardown - stop, doctor`.

Each command's block in `transcript.log` starts with a `$ ` line and ends with an `[exit N] <timestamp>` line; copy the whole block verbatim.

````markdown
### <feature file> - <step name>

- Verdict: pass | fail | manual | not driven
- Note: one or two sentences. For fail, what happened instead. For manual, why the map is wrong. For not driven, what it needed.
- Captured: what proves it (envelope, page text, rows, keys), and file names in the run folder.

```text
$ <each command exactly as transcript.log has it>
<its output>
[exit N] <timestamp>
```
````

A check is one of:

- `pass`: the product does what the check says.
- `fail`: it does not, and the code is wrong.
- `manual`: it does not, and the map is wrong, because the change meant this. The map changes in the same PR.
- `not driven`: it needs something a run cannot reach. The check stays with the user.

The verdict at the top is one of **Done**, **Done, with n not driven** (name them), **Not done** (name the failed checks), or **Done once the map changes in this PR**.

The proof bar:

- Drive the user's real path: `/mcp` with a token from `login`, the operator script, the pages. Never an internal setter, a durable object method, or a test-only endpoint.
- Capture the action and the state it led to, not only the final answer.
- Check side effects as well as what is returned: rows in the owner store, keys in the vault and KV. Name the value that must be absent as well as the one that must be present.
- Cover every entry point the map lists for the feature. One not driven is reported as not driven, never as verified through another.
- Use a fake only where production already puts a boundary around the external system the check is not about. The GitHub stand-in is the only one a run uses.

## Stop

```bash
.agents/skills/verify/opti-verify.mjs stop <run>
```

It sends SIGTERM to the run's recorded wrangler and stand-in pids only, waits for them and every child process recorded under them to exit, and reports each as `stopped` (or `not running (nothing to stop)` if it had already died), and the worker port and stand-in port each as `closed`.
It exits 0 only when nothing it recorded is left running and both ports are closed; that is the proof.
Never stop anything by process name: another run, the user's own `pnpm dev`, or `pnpm test` may be running.
Run `doctor <run>` after it; it must say `UNFIT`, with the wrangler, stand-in, port and `/health` lines all `BAD` (the source line may still be `ok`).
The run folder and its evidence stay.
`opti-verify.mjs list` shows every run as `running`, `stopped`, or `BROKEN` when only one of its two processes is left.
