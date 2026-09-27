# OPTI manual

What OPTI does, feature by feature, and what you should see at each step.
A person reads it as the product's checklist; the verify skill (`.agents/skills/verify/`) reads it as the recipe for a check.

OPTI is an MCP server with exactly three tools, `search`, `execute` and `packages`, behind an OAuth login.
Its verify skill ships one helper; `verify` below means typing `.agents/skills/verify/opti-verify.mjs`, from the repository root.

## Start from a known state

- Start a run with `verify start`; it prints the run id, the run folder and the origin.
- The run has its own empty state in the run folder: no clients, no owner, no records, no packages, no credentials.
- The GitHub stand-in is always signed in as `github:4242`, the only identity the run allows in.
- Run `verify doctor <run>` before the first step and again after `verify login <run>`, and require `FIT` both times.
- Never drive an instance this run did not start.

## Driving conventions

- Run everything from the repository root. `<run>` is the run id `start` printed, and `<run folder>` is `.scratch/verify/<run>`.
- Every feature except the login needs `verify login <run>` first.
- Put each module in `<run folder>/modules/<name>.js` (`start` creates the empty folder) with exactly the content the step gives, and run it with `verify exec <run> <run folder>/modules/<name>.js`.
- Put JSON arguments longer than a line in `<run folder>/modules/<name>.json` and pass them as `@<run folder>/modules/<name>.json`.
- Take commands literally: keep quoted names, keys and flags as written.
- What a feature writes is read back with `verify inspect`, in its `Behind it` section or in the step itself.
- Run ids, client ids, owner ids and timestamps differ every run; compare everything else.
- Quoted output is how the output starts, or the fields it must contain; the rest may say more. The helper pretty-prints JSON across lines, so compare fields and values, not line layout.
- In an `ok` envelope the `runId` sits under `value`; in a failure it sits under `error`.
- Every step is a check, and so is every command in a `Behind it` section together with the sentences that say what it must print. An entry point with no step of its own is not driven.
- Each feature file assumes a fresh run, so start one per file. The one exception is [Connect a host](./connect-a-host.md), which is the login itself: it may open the run of any other feature.

## Feature file shape

Each file opens with the feature's name and one paragraph on what a user gets from it, then these sections, in order:

1. `Entry points`: every way a user reaches the feature.
2. `Steps`: each step is the user's action, the command that performs it, and what you should see.
3. `Behind it`: the state the steps leave, and how to read it.
4. `Gotchas`: what wastes a run or makes a check lie.

No implementation details: only user paths, handles, commands, state and what proves it.

## Features

- [Connect a host](./connect-a-host.md): the OAuth login an MCP host walks, the consent screen, and the three tools it finds.
- [Execute a module](./execute.md): running code in a fresh sandbox, tagged failures, logs, storage across runs, and the run record every run leaves.
- [Search](./search.md): the ranked default list, a filter, full detail for one entry, and the empty result.
- [Packages](./packages.md): create, publish, import, a publish that fails its check, and creating from a run.
- [Credentials and host approval](./credentials.md): the denial and its approval link, the operator command, the credentialed fetch, and where the value must never appear.

Not in the map yet, because a run cannot reach it: the `vault` capability (the container is off in every run) and anything that needs production.
