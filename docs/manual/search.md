# Search

An agent asks what OPTI can do and gets a short ranked list of capabilities and its own published packages, typed in TypeScript, and full detail only when it asks for one entry by name.

## Entry points

- The `search` tool through `tools/call` on `/mcp`, with no arguments, `{query}`, or `{name}`.

## Steps

Preconditions: `verify login <run>`, and nothing published yet.

- **Everything, ranked.** Run `verify tool <run> search`.
  It exits 0 and prints `envelope: ok` with five `results`, in order `add`, `fetch`, `runs`, `storage`, `vault`, each with `"kind": "capability"`, a `summary` and a TypeScript `signature`, and nothing else per entry.
  `add` reads `"signature": "add(a: number, b: number): number"`.
- **A filter.** Run `verify tool <run> search '{"query":"storage"}'`.
  Exactly one result, `storage`, with the signature `storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean>; list(prefix?: string): Promise<{ keys: string[]; truncated?: string }> }`.
- **Detail for one entry.** Run `verify tool <run> search '{"name":"storage"}'`.
  One object, not a list, with `"importLine": "import { storage } from \"opti:capabilities\";"`, `"errorTags": ["InvalidStorageKey", "StorageValueTooLarge", "FetchBudgetExhausted"]`, an `example` whose `result` is `{"hello": "world"}`, and the capability's `code`.
- **Nothing matches.** Run `verify tool <run> search '{"query":"zzzz-nothing"}'`.
  It exits 0 with `"results": []` and `"hint": "nothing matched. What exists: add, fetch, storage, runs, vault. Also: no credentials are saved yet"`.

## Behind it

Search is read-only: after every step above, `verify inspect <run> store "SELECT count(*) AS n FROM run_records"` prints `0`, and `verify inspect <run> kv` shows only the keys the login left.

## Gotchas

- The no-credentials sentence in the empty hint disappears once a credential is saved; a run that did the credentials feature first sees a different hint.
- Published packages join this list with `"kind": "package"`; see [Packages](./packages.md).
