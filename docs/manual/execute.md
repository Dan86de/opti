# Execute a module

An agent sends one ES module, OPTI runs it in a fresh sandbox, and the agent gets back its return value and logs, or a tagged failure with a retry class, plus the id of the run record every run leaves.

## Entry points

- The `execute` tool, `{code}`, through `tools/call` on `/mcp`.

## Steps

Preconditions: `verify login <run>`.

- **A module that works.** `modules/add.js`:

  ```js
  import { add } from "opti:capabilities";
  export default async () => {
    console.log("adding");
    return { sum: add(2, 3) };
  };
  ```

  Run `verify exec <run> <run folder>/modules/add.js`.
  It exits 0 and prints `envelope: ok` with `"result": {"sum": 5}`, `"logs": ["log: adding"]` and a `"runId"`.
- **A module that throws.** `modules/throws.js`:

  ```js
  export default async () => {
    throw new Error("boom from the module");
  };
  ```

  Run `verify exec <run> <run folder>/modules/throws.js`.
  It exits 2 and prints `envelope: failure Error (retry never)` with `"message": "boom from the module"` and a `"runId"`.
- **An import that was never granted.** `modules/ungranted.js`:

  ```js
  import { nope } from "opti:capabilities";
  export default async () => nope();
  ```

  Run `verify exec <run> <run folder>/modules/ungranted.js`.
  It exits 2 and prints `envelope: failure SyntaxError (retry never)` with a message starting `the module could not be loaded: The requested module 'opti:capabilities' does not provide an export named 'nope'`.
- **Storage keeps a value across runs.** `modules/storage-set.js`:

  ```js
  import { storage } from "opti:capabilities";
  export default async () => {
    await storage.set("verify:greeting", { hello: "world" });
    return await storage.list("verify:");
  };
  ```

  Run `verify exec <run> <run folder>/modules/storage-set.js`.
  It exits 0 and prints `envelope: ok` with `"result": {"keys": ["verify:greeting"]}`.
  Then `modules/storage-get.js`:

  ```js
  import { storage } from "opti:capabilities";
  export default async () => await storage.get("verify:greeting");
  ```

  Run `verify exec <run> <run folder>/modules/storage-get.js`, a second run in a second fresh sandbox.
  It exits 0 and prints `envelope: ok` with `"result": {"hello": "world"}`.
- **Past runs are queryable from a run.** `modules/runs.js`:

  ```js
  import { runs } from "opti:capabilities";
  export default async () => await runs.query({ outcome: "failure" });
  ```

  Run `verify exec <run> <run folder>/modules/runs.js`.
  It exits 0 and prints `envelope: ok` with a `"result"` array holding exactly the two failed runs, the ungranted import and then the throw (newest first), each with `"source": "execute"`, `"outcome": "failure"` and a `"totalMs"`.

## Behind it

Every run above wrote one record, failures included, and storage holds one row:

```bash
verify inspect <run> store "SELECT run_id, source, outcome FROM run_records ORDER BY created_at"
verify inspect <run> store "SELECT key, value FROM storage_data"
```

The first lists six rows, in order: `success`, `failure`, `failure`, `success`, `success`, `success`, all with source `execute`, and their run ids are the ones the envelopes printed.
The second prints exactly one row, `verify:greeting` with `{"hello":"world"}`.

## Gotchas

- `verify exec` exits 2 for a failure envelope. That is the tool answering, not the helper failing; the check decides whether a failure was expected.
- `storage` keys match `[a-z0-9:._-]+`. An uppercase key is refused with `InvalidStorageKey`, which is not a crash.
- Never execute a CPU-bound infinite loop in a run: locally it crashes workerd rather than being cut off, and the run has to be stopped and started again.
- The `vault` capability imports fine but every call fails with `VaultUnavailable` in a run, because the container is off.
