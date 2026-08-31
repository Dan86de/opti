# OPTI

The glossary for OPTI, an MCP server with exactly three tools.
The spec (`spec.md`) is the record of decisions; this file is the record of language.

## Language

**Owner**:
The authenticated human a request acts for, identified by an opaque generated id.
_Avoid_: user, account

**Capability**:
A primitive OPTI ships, importable inside a run from the virtual module.
_Avoid_: tool (reserved for the three MCP tools), builtin

**Package**:
A named, owner-scoped set of source files created from a proven run or from source, discoverable through `search` once published.
_Avoid_: script, snippet, app

**Run**:
One execution of one submitted module in one fresh isolate.

**Run record**:
The durable account of one run: what was asked, what happened, timings and logs.
_Avoid_: log, history entry

**Isolate**:
The fresh Worker Loader sandbox a run executes in, with no parent environment.
_Avoid_: sandbox worker, container

**Gateway**:
The Worker entrypoint every byte leaving an isolate passes through; the credential boundary.

**Placeholder**:
The `{{credential:name}}` text a run writes where a credential value goes; substituted outside the isolate.

**Virtual module**:
The generated `opti:capabilities` module map an isolate imports from; a grant list, not a boundary.

**Owner vault**:
The per-owner durable object holding credentials, host policy and daily counters; the secrets object.
_Avoid_: vault DO, credential vault

**Owner store**:
The per-owner durable object (Slice 3, SQLite) holding run records, package state and storage data; the work object.
_Avoid_: archive, workspace

**Storage**:
The capability sandboxed code imports to keep owner-scoped key-value state across runs.
_Avoid_: store (that word names the durable objects), database

**Envelope**:
The one response shape every result crosses the boundary in: `ok` with a value, or a tagged failure.

**Publish**:
The explicit act that makes a package version the one `search` finds and runs import; never inferred from contents.
_Avoid_: deploy, activate (activation is what publish grants, not a separate verb)

**Slice**:
One of the three build stages; nothing outside the current slice until all three are done.

## Relationships

- An **Owner** has exactly one **Owner vault** and exactly one **Owner store**
- A **Run** produces exactly one **Run record**, written to the **Owner store**
- A **Package** lives in the **Owner store** and becomes discoverable only through **Publish**
- **Storage** reads and writes the **Owner store**, reached only through the **Gateway**
- The **Owner vault** is reachable from a run only through the **Gateway**'s credential resolution, never through **Storage**
- A **Package** may import **Capabilities** and other **Packages**; a **Capability** never imports a **Package** (shipped code must not depend on owner-mutable code)

## Example dialogue

> **Dev:** "When a run calls **storage**, does that touch the **owner vault**?"
> **Domain expert:** "Never. Storage lives in the **owner store**; the vault holds secrets and only the **gateway**'s credential resolution reads it."

## Flagged ambiguities

- "store" was used for both the sandbox capability and the durable objects. Resolved: the capability is **storage**; the durable objects are the **owner vault** and the **owner store**.
