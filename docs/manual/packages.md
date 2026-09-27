# Packages

An agent keeps code it proved as a named package, publishes it when it is ready, and from then on finds it in search and imports it by name from any run; a publish that fails its check leaves the last good version serving.

## Entry points

- The `packages` tool through `tools/call` on `/mcp`: `create` from source, `create` from a run, `read`, `edit`, `publish`.
- `import ... from "opti:packages/<name>"` inside an executed module.
- `search`, which lists published packages.

## Steps

Preconditions: `verify login <run>`.

- **Create from source.** `modules/greet-package.json`:

  ```json
  {"action":"create","name":"greet","summary":"Greet someone by name.","files":[{"path":"index.ts","content":"export const greet = (name: string): string => `hello, ${name}`;\n"}],"exports":[{"name":"greet","signature":"greet(name: string): string"}]}
  ```

  Run `verify tool <run> packages @<run folder>/modules/greet-package.json`.
  `envelope: ok` with `{"created": "greet", "state": "draft"}`.
- **A draft cannot be imported.** `modules/use-greet.js`:

  ```js
  import { greet } from "opti:packages/greet";
  export default async () => greet("verify");
  ```

  Run `verify exec <run> <run folder>/modules/use-greet.js`.
  It exits 2 with `envelope: failure Error (retry never)` and a message starting `the module could not be loaded: No such module "opti:packages/greet".`
- **A draft is not in search.** Run `verify tool <run> search '{"query":"greet"}'`.
  `"results": []`.
- **Publish.** Run `verify tool <run> packages '{"action":"publish","name":"greet"}'`.
  `envelope: ok` with `{"published": "greet", "exports": ["greet"]}`.
- **Search finds it.** Run `verify tool <run> search '{"query":"greet"}'`.
  One result: `"kind": "package"`, `"name": "greet"`, `"summary": "Greet someone by name."`, `"signature": "greet(name: string): string"`.
- **Import it.** Run `verify exec <run> <run folder>/modules/use-greet.js` again.
  `envelope: ok` with `"result": "hello, verify"`.
- **A broken export cannot reach live.** Run `verify tool <run> packages '{"action":"edit","name":"greet","exports":[{"name":"greet","signature":"greet(name: string): string"},{"name":"missing","signature":"missing(): void"}]}'`.
  `envelope: ok` with `"edited": "greet"`.
  Then run `verify tool <run> packages '{"action":"publish","name":"greet"}'`.
  It exits 2 with `envelope: failure PublishCheckFailed (retry never)` and a message starting `the package does not typecheck:` that names `Property 'missing' is missing`.
- **The last good version still serves.** Run `verify exec <run> <run folder>/modules/use-greet.js`.
  `envelope: ok` with `"result": "hello, verify"`.
- **Create from a run.** Run any module that succeeds, such as `add.js` from [Execute a module](./execute.md), and take its `runId`.
  Run `verify tool <run> packages '{"action":"create","name":"adder","fromRun":"<runId>"}'`.
  `envelope: ok` with `{"created": "adder", "state": "draft"}`.
- **Read them all.** Run `verify tool <run> packages '{"action":"read"}'`.
  Two packages, sorted by name: `adder` in state `draft` with the summary `Created from run <runId>; a frozen first attempt.`, and `greet` in state `modified` with `Greet someone by name.`.

## Behind it

```bash
verify inspect <run> store "SELECT name, revision, published IS NOT NULL AS has_published FROM packages ORDER BY name"
```

It prints `adder|1|0` and `greet|2|1` as rows: `adder` was never published, and `greet` has a published snapshot even though its working revision is ahead of it.

## Gotchas

- Package files are TypeScript and publish typechecks them; the first publish in a run pays for loading the compiler, a few seconds.
- A package imports capabilities as `opti:capabilities`, exactly like a submitted module; publish rewrites the specifier so it resolves from inside the package.
- `modified` means the working state differs from the published snapshot, not that publish failed. The failure is only in the publish envelope.
