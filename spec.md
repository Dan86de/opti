# OPTI: the first three slices

Spec frozen 2026-08-31.
Covers Slice 1 (walking skeleton), Slice 2 (credential boundary), and Slice 3 (things that persist).
This document is now the record. The earlier planning notes it was drawn from have been deleted, so anything not written here is not written down.

## Problem Statement

I want an assistant that can actually do things in my own accounts, and I want it to get better at doing them every time I use it.

Today, every time I want my agent to touch Gmail, my calendar, Notion or Todoist, one of two things happens.
Either somebody has already built a tool for exactly that, in which case I get their idea of what I wanted, or nobody has, in which case I am stuck.
And when I do get something working, it evaporates.
The next conversation starts from zero and I explain the whole thing again.

The two obvious ways to fix that are both wrong for me.

Building a tool per ability means the tool list is uploaded into my agent's context on every single conversation, so my ambition is capped by somebody else's context budget, and any multi-step task becomes a dozen round trips through the model with a dozen chances to lose the thread.

Handing the agent my credentials and letting it write whatever code it likes solves the capability problem and creates a much worse one.

What I want is a system where a missing capability is the normal starting state rather than a blocker, where my agent can build the thing it needs out of primitives on the day I first need it, where the credential to do that never enters the code that uses it, and where the thing it built stops being a one-off.

## Solution

OPTI is an MCP server with exactly three tools.

**`search`** answers "what can you do", over both the capabilities OPTI ships and the packages I have accumulated.
It returns signatures as types, because the next thing that happens is that a model writes code.
The default response is small, because it is the response paid for on every call, and full detail is a second explicit call.

**`execute`** runs one ephemeral module in which everything `search` found is an ordinary import.
Loops, filters, branches and error handling happen inside that one module rather than as a chain of round trips.
The module runs in a fresh isolate with no ambient credentials, and it holds no identity of its own.

**`packages`** turns a run that worked into a named, published thing.
It is lifecycle only: create from a run or from source, read, edit, publish.
Anything that is behaviour rather than lifecycle is a capability reached from inside `execute`.

What changes for me, concretely.

I connect a real MCP host to OPTI and use it from a chat window I did not have to build.
When I ask for something OPTI has never done, `search` comes back empty but points at `fetch` and at my saved credentials, so the agent builds it anyway.
When it needs a credential I have not saved, or a host I have not approved, it stops and hands me a link rather than retrying, because approving egress is the one thing no agent surface can do.
Once it works, one call turns that run into a package, and the next conversation finds it instead of starting over.

The credential itself is never in the code.
The code writes the credential's name where the value goes, and OPTI substitutes the real value outside the isolate, only for a host I already approved.

## Build Order

Three slices, in this order, and nothing else until all three are done.

The conversational surface is a real MCP host pointed at the endpoint.
No chat client is built, in any slice, because the point of speaking MCP is that the conversational surface is somebody else's problem.

### Slice 1: walking skeleton

MCP over HTTP with an OAuth provider in front and correct protected-resource metadata.
An upstream login, so the owner id exists at all.
`search` returning one hardcoded entry.
`execute` booting a real isolate with a virtual module holding that one entry.

**Done when.**
A real MCP host completes the authorize flow, and "ask OPTI what it can do, then have it add two numbers" returns the right answer.

**Proves.**
The tool surface, transport and identity, the isolate, and what the sandbox can import.
There is no product yet, which is the point.

**Decisions.**
Taken on 2026-08-31, in the interview that closed the four open questions the Worker Loader spike had left.
They are recorded here because a later reader would otherwise have to re-derive each one from the code.

**Transport.**
Stateless MCP over HTTP, written against `unstable/http` rather than `McpServer.layerHttp`.
`layerHttp` keeps sessions in an in-memory map, issues an `mcp-session-id` on initialize, rejects any non-initialize request that omits it, and returns 404 for a session id it does not hold.
On Workers that map lives in an isolate that can be evicted between requests, so a well-behaved host would be told to start over at unpredictable moments.
OPTI issues no session id at all, which the protocol permits, so the 404 path does not exist.
`Schema` and `Tool` are still used for the tool definitions; only the transport shell is ours.

**Identity.**
GitHub is the upstream login, and it is deliberately unrelated to any service OPTI will later hold a credential for, so that a login session and a saved credential stay two separate grants.
The owner id is opaque and generated, never a provider subject, because welding identity to a provider makes a second provider a migration.
A mapping from `(provider, subject)` to the owner id lives in the OAuth provider's KV, which is the pre-authentication exception the storage placement section already names.
The grant seals the opaque owner id, so linking a second provider later does not invalidate a token already issued.
Identities are never linked by email address: providers hand out unverified addresses, so linking is an explicit act taken while already authenticated as an existing owner.
Minting a new owner id is gated by an allowlist held as a secret, because dynamic client registration in front of a public upstream login otherwise hands an isolate to anyone who asks.
There are no scopes, because a field set on every grant carries no signal.
The authorize screen leads with the redirect URI's origin rather than the client's self-declared name, which is the only part of a dynamically registered client an attacker does not choose.

**The tool surface.**
Slice 1 ships `search` and `execute`; `packages` arrives in Slice 3 with something behind it.
Three is the ceiling and a fourth is the tripwire, but advertising a tool that always fails teaches a model that the server is broken.
`search({ query })` returns the slim list, `search({ name })` returns detail, and `search({})` returns everything ranked, so asking for the full list needs no third mode.
A bounded list carries a truncation marker, because a silently cut list teaches a model that the missing thing does not exist.
An empty result names the primitives that do exist rather than returning nothing.
The slim response and the `tools/list` response each have a 2KB ceiling, asserted in a test, because the tool list is paid on every conversation whether or not OPTI is used.
Error tags appear in detail only, since they are the field most likely to blow the ceiling as capabilities accumulate.
Every worked example in a detail response is a live test fixture, because a stale example is worse than no example: it is the part a model copies most literally.

**Execute.**
The runner generates the entry module, and the model writes `submitted.js`, a default-exported async function returning a JSON-serializable value.
Putting the model's code in its own module keeps two failure modes apart: an ungranted import or a syntax error fails at import, before any statement runs, and a bug fails inside the call.
The generated entry catches, reads the tag off whatever was thrown, shadows `console.*` to collect logs, and serialises the envelope itself, because a rejected `fetch` on the host side leaves nothing but a message string.
The host parses that body with `Schema` rather than trusting its shape; a malformed body is likely and a lying one is not, because the code is the owner's own agent writing to the owner.
`execute` takes code and nothing else, so there is no second path for data to reach the sandbox before anything needs one.
A failure crosses the MCP surface as a tool result carrying the envelope, with `isError` mirroring `ok`.
JSON-RPC errors are reserved for protocol faults, because a host that sees one may surface it as a malfunction and never hand the payload to the model, which deletes the retry classification and the approval link that Slice 2 depends on.
An oversized result is a failure and is never truncated; oversized logs are truncated with a marker naming what was dropped.
That asymmetry is deliberate: a model reasoning over a result that quietly lost its tail is confidently wrong, while a run that succeeded should not be failed for being chatty.

**The isolate.**
It is named for the owner and the run, so no two runs share one and no two owners can.
`LOADER.get` caches by name, and the obvious warm-start optimisation is to name it after a hash of the code, which would put two owners in one isolate whose `globalOutbound` belongs to whoever arrived first.
The negative assertion that two owners running identical code do not share an isolate is what fails on the day someone tries it.
`limits` is passed and is never relied on.
A fixed host-side timeout races the sandbox call and returns a timeout failure, which stops the waiting and does not claim to have stopped the isolate.
The boundary is `globalOutbound` plus the absent `env`, and not the module map.
The virtual module is a grant list rather than a boundary: `node:` builtins are reachable, rejecting the specifier statically is defeated by a computed dynamic import, and `LOADER.get` offers no way to deny them.
That costs nothing, because the three ways out of an isolate turn out to be three ways of asking one gate, and `globalOutbound: null` closes it.
The residual, stated so nobody later assumes otherwise: the sandbox can compute anything, read `node:` builtins and burn CPU; it cannot reach the parent environment, and it cannot reach the network except through the seam.

**Environment configuration arrives through the bindings interface**, the upstream's base URL included, so the deployed worker contains no test-only code path and the difference between local and production is visible in configuration rather than in a conditional.

**Testing.**
Tokens are minted directly with `getOAuthApi().completeAuthorization()` for the tests about the MCP surface, so an assertion about a size ceiling does not pay for an OAuth dance.
One test drives the authorize path end to end against a doubled upstream, which is where the allowlist, the identity mapping and the props sealing live.
That double proves our callback handles a GitHub-shaped response and not that GitHub sends one, which is the shortcut to write at the test.
The real round trip is verified by hand, which is what the done-when describes: a person clicking approve in a real host.
Done on 2026-08-31 against the deployed worker: registration, the consent screen, GitHub itself, and the redirect back to the client carrying an authorization code.
That is the half the double cannot prove, and it is now proved once rather than assumed; the double covers it on every run from here.

**Build order inside the slice.**
The socket-escape test first, because it is a test file rather than an endpoint and because it is the one finding that would stop the slice.
Then OAuth and identity, so nothing is ever reachable unauthenticated.
Then the MCP surface and `search`, then the runner and the virtual module builder, then deploy and run the production runaway experiment.

**Still open, and how each closes.**

1. Whether anything reaches the network without passing `globalOutbound`.
   Answered locally on 2026-08-31 in `packages/server/test/worker/sandbox-egress.test.ts`, and the answer is that nothing does.
   With `globalOutbound: null`, `fetch`, `cloudflare:sockets` `connect()` and `node:net.createConnection` are refused by workerd with one message, and a listener on the other side records no connection.
   The same three paths reach that listener when outbound is granted, which is the control that makes the denial mean something.
   What remains is running the same file against Cloudflare's loader rather than miniflare's, which happens at the deploy step alongside the runaway experiment.

2. Whether a runaway kills the invocation or the host.
   That is the question, and not whether `cpuMs` bounds a busy loop.
   Answered by loading a runaway through the deployed loader once the runner exists and the timeout guards it.
   If production behaves the way local did, Slice 1 ships with a known hole, written down, and the daily ceiling in Slice 2 is what limits how often it is reached.

**Closed by not needing an answer.**
No bundler in Slice 1: one hardcoded capability, no bare npm specifiers, and Worker Loader already resolves imports among the map's own members.
Whether `@cloudflare/worker-bundler` runs inside a Worker stays unverified on purpose, and the trigger to find out is the first sandbox module with a bare specifier.

**The Worker Loader bet, with its revisit trigger named.**
Every alternative is a platform migration rather than a swap, so the bar is where the platform stops delivering something this spec treats as non-negotiable.
Reopen the bet if egress escapes `globalOutbound` with no way to close it; if a runaway takes down the host, measured on production, with no configuration that bounds the blast radius to one invocation; or if the feature's availability moves against us, by being withdrawn from open beta without going GA, gated behind a plan we are not on, or priced so that a fresh isolate per execution stops being viable.
`limits` being unreliable while the invocation still dies alone is not that trigger, and neither is cold start being slower than we would like, nor needing a bundler.
Reviewed at the start of Slice 3, which is already a moment the spec asks you to look up from the code.

### Slice 2: credential boundary

`fetch` in the virtual module, routed out through the gateway.
One credential, encrypted with the owner and the purpose bound as additional authenticated data.
A host allowlist that starts empty, denies by default, and is approved only through an operator command.

**Done when.**
A request to a third-party API is denied with a typed error carrying an approval link, the host is approved from the terminal, and the same request then succeeds.
The credential never enters the isolate.

**Proves.**
The credential boundary.
The only slice here where being wrong means a rewrite rather than an edit.

### Slice 3: things that persist

Run records for every execution, written to owner-local storage and never as a synchronous write on a relational hot path.
`storage` in the virtual module, owner-scoped like everything else.
`packages`: create from a run, read, edit, publish, and `search` returning your own packages ranked above the primitives.

**Done when.**
"That worked, save it as todoist", and then in a brand new conversation "what are my todos" finds the package instead of starting over.
And a failure is debuggable from its run record alone, without adding a log line and reproducing it.

**Proves.**
Discovery, run records, the source primitive, publish and activation, and that the loop closes.

**Watch for.**
This is the slice that introduces the first durable object, which is the moment the deployment-split trigger becomes live rather than theoretical.
A deploy of the script that owns a durable object class restarts those objects.
Stored data survives; in-memory state and in-flight requests do not.
At one owner that is nearly free, so the trigger to act on is not a felt performance problem but the first durable object holding state whose restart is user-visible.

## User Stories

### Slice 1: walking skeleton

1. As the owner, I want to connect a real MCP host to OPTI with my own account, so that I can use OPTI from a chat window I did not have to build.
2. As an MCP host, I want a 401 that advertises where to authorize, so that I can discover the token endpoint without being configured by hand.
3. As an MCP host, I want to register dynamically, so that I can connect without the operator provisioning a client for me first.
4. As the owner, I want the authorize screen to name what is being granted, so that I know what I approved.
5. As the owner, I want the bearer token's audience checked against the origin, so that a token minted for something else cannot be replayed here.
6. As an agent, I want exactly three tools, so that my context budget is not spent on a catalog before the conversation has started.
7. As an agent, I want `search` to return signatures as types rather than JSON Schema, so that I get them in the language I am about to write in.
8. As an agent, I want the default `search` response bounded, so that the call I make on every turn is the cheap one.
9. As an agent, I want to ask for detail explicitly, so that full input and output types, the error tags a call can raise, and a worked example arrive only when I need them.
10. As an agent, I want to submit one module that loops and branches, so that a multi-step task is one round trip rather than a dozen.
11. As the owner, I want submitted code to run in a fresh isolate, so that a module that throws, hangs, or loops forever cannot take down the server.
12. As the owner, I want the isolate to receive no parent environment, so that code cannot read anything it was not explicitly given.
13. As an agent, I want capabilities as concrete named imports from one virtual module, so that a capability I was not granted fails at the import line rather than halfway through a run.
14. As an agent, I want everything I can reach to be typed, and to be able to reach nothing else, so that I can write correct code on the first attempt.
15. As an agent, I want every response in one envelope, so that success and failure have the same shape.
16. As an agent, I want a failure to carry a tag and a retry classification of now, after, or never, so that I can recover without reading a stack trace.
17. As an agent, I want an uncaught throw inside my module encoded into the envelope with its tag intact, so that the boundary does not flatten what went wrong.
18. As the owner, I want several of my agents and conversations to talk to OPTI at the same time, so that running subagents does not produce bugs nobody can reproduce.
19. As the owner, I want the owner id derived from the authenticated request and never from the connection or from an argument the sandbox passed, so that authority cannot travel with a caller.
20. As the owner, I want the owner id threaded through every data-layer call from the first commit, so that a second person later is enforcement work rather than a migration.

### Slice 2: credential boundary

21. As the owner, I want to save a credential, so that my agent can reach a service that has no capability yet.
22. As the owner, I want saving a credential to authorize nothing, so that the value and the permission to send it are two separate grants.
23. As the owner, I want to approve one specific host for one specific credential, so that egress is something I decided rather than something that accumulated.
24. As the owner, I want a credential to start with an empty host allowlist, so that deny is the default and stays the default until I say otherwise.
25. As the owner, I want host approval to be unreachable from every agent surface, so that no tool, no sandboxed code, no package, and no capability handler can widen my egress.
26. As an agent, I want to write a credential's name where its value goes, so that I can call an authenticated API without ever holding the credential.
27. As the owner, I want substitution to happen outside the isolate after the code has run, so that the running code never has the value in scope.
28. As an agent, I want a denial to carry an approval link pre-filled with the credential name and the host, so that I can hand the problem to a human in one message.
29. As an agent, I want a denial classified as never-retry, so that I stop instead of looping.
30. As the owner, I want the credential value absent from the error, from logs, and from run output, so that a denial does not leak the thing it was protecting.
31. As the owner, I want credentials encrypted at rest with my identity and the credential's purpose bound into the ciphertext, so that a row copied into another owner's place fails to decrypt.
32. As the operator, I want a command that approves a host, so that Slice 2 is finishable before any web application exists.
33. As an agent, I want to build a working integration out of `fetch` and a saved credential, so that a missing capability is a starting point rather than a blocker.
34. As the owner, I want an OAuth integration's allowed host set resolved before its token is attached to a request, so that an opaque bearer is protected even though the gateway cannot inspect it.
35. As the owner, I want that check to apply to every code path that materializes a token, so that the protection is a property of the system rather than of one helper.
36. As the owner, I want token refresh to happen host-side and return only metadata, so that refresh does not quietly become a second way to materialize a credential.
37. As the owner, I want operator-provisioned credentials kept outside the credential store entirely, so that no placeholder can name them and sandboxed code has no resolution path to them.
38. As the owner, I want a daily ceiling on executions and on outbound fetches, so that a runaway loop has a floor under it.

### Slice 3: things that persist

39. As an agent, I want to turn a run that worked into a named package without resending the code, so that keeping something costs one call.
40. As an agent, I want to create a package from source I just wrote, so that I can write the proper version rather than freezing a first attempt.
41. As the owner, I want create and publish to be separate steps, so that working state and live state are different things.
42. As the owner, I want publish to check that the exports a package declares actually exist, so that a broken export cannot reach live.
43. As the owner, I want a failed publish check to leave the previous version serving, so that publishing is always safe to attempt.
44. As the owner, I want activation to be explicit and never inferred from contents, so that a file appearing or a rename cannot silently change what my system runs.
45. As an agent, I want to edit one file of a package without rewriting the others, so that a small change stays a small change.
46. As an agent, I want `search` to return my packages alongside capabilities in one result set, so that I find the thing I already proved.
47. As an agent, I want every result to say which of the two it is, so that I write the right import.
48. As an agent, I want a package I proved ranked above a general primitive when both match, so that what I build compounds instead of being rediscovered.
49. As an agent, I want to import one package from another by name, so that composition is ordinary code rather than a new verb.
50. As the owner, I want every execution to write a run record carrying what was asked, what happened, how long it took, phase timings and captured logs, so that the system's past is readable.
51. As the owner, I want to query runs by time, by source and by outcome, so that "what ran yesterday and what failed" is one call.
52. As the owner, I want to debug a failure from its record alone, so that I do not have to add a log line and reproduce it.
53. As the owner, I want run records written to owner-local storage rather than as a synchronous write on a relational hot path, so that history does not become the ceiling.
54. As an agent, I want owner-scoped storage in the virtual module, so that a package can keep state without inventing its own store badly.

### Cutting across all three

55. As the owner, I want local development to attach every binding for real, including the loader and the gateway, so that a green local run is never mistaken for proof of a boundary that local never had.
56. As the owner, I want every shortcut a non-production run takes written down at the test, so that the difference between local and production is visible rather than assumed.
57. As the owner, I want one runner behind every entry point, so that who called and what authorized it differs at the door and never inside the runner.

## Implementation Decisions

### Platform and language

Cloudflare Workers, chosen because Worker Loader delivers three of the four one-way doors in a single binding: the isolate, control over what bindings the loaded worker receives, and the module map.
Worker Loader is open beta on the paid plan; this is a recorded bet, and its revisit trigger is named under Slice 1.

Effect on the host.
Plain `async`/`await` TypeScript inside the sandbox, because the capability boundary serializes, so an effect runtime in the isolate would pay full cost for no shared context, and because models write plain promises far more reliably.

pnpm workspaces, no task runner until builds are slow enough that caching pays.

One deployable through Slice 3.

### Modules

**Owner context.**
Builds from an authenticated request and is the only way an owner id comes into existence.
Provided once per request as a context service and constructible from nothing else.
No data-layer function can be called without it.

**Host policy.**
Answers which hosts a given credential may reach for a given owner.
Its write path is exported to the operator command and to nothing else.
The unreachability of that write path from the capability layer is the security property itself, which is why this is a separate module from the credential store rather than a flag on it.

**Credential store.**
Get, put, list.
Encrypted at rest, with the owning identity and the credential's purpose bound as additional authenticated data, so a ciphertext moved into another owner's row fails to decrypt.
Operator-provisioned credentials live outside this store entirely, in a separate place with its own purpose, so no placeholder can name one.

**Fetch gateway.**
Takes an outbound request and the resolved policy, returns a response or a typed denial.
Scans for placeholders, resolves the allowlist, substitutes values, refuses an off-list request before the network call, constructs the denial with its approval link, and redacts values from anything that leaves.
For OAuth integrations it resolves the integration's allowed host set from its declared required hosts plus the host of its API base before attaching the header, and the token never appears in the error.
This module is the credential boundary and the most expensive thing in the spec to retrofit.

**Virtual module builder.**
Takes the resolved capability set for one execution and produces the module map the isolate imports from.
Concrete named exports, generated per execution, so an ungranted capability fails at import rather than at call.
Not proxied globals: imports are greppable, typeable, and visible in the code the model wrote.

**Runner.**
Takes code, a module map and an owner context; returns an envelope.
Creates the isolate without the parent environment, binds outbound fetch to the gateway, applies limits, captures logs and phase timings, and encodes an uncaught throw with its tag intact.
One runner sits behind every entry point: `execute` now, schedules and webhooks later.
Authorization differs at the door and never inside the runner.

**Registry.**
Resolves what exists for a given owner.
Built-in capabilities are a module in the bundle at this size, not a table.
The seam packages plug into in Slice 3.

**Discovery.**
Query in, slim or detail out.
Lexical ranking only.
Results span capabilities and packages in one set, each tagged with which it is because the import path differs, and a proven package outranks a general primitive when both match.

**Run records.**
Write a record; query by time, source and outcome.
Owner-local storage, never a synchronous relational write.
Entity rows hold state and run records hold history; nothing derives current state by scanning records.

**Package store.**
Source files, history, an identity that survives a rewrite, a staged published pointer, and publish checks.
Publish is one transaction and a failed check leaves the previous version serving.
An editing session opens, patches, checks, commits and closes, so one file changes without rewriting the whole package.

**Envelope and error taxonomy** are a shared kernel rather than a module.
Everything imports them and they have no implementation to hide.
Failures are tagged errors carrying a tag, a retry classification of now, after or never, and an optional action for when a human must intervene.
An absent field means the boring default, so a present field is always a signal.

### Contracts

The tool surface is exactly three, and stays three.
`packages` takes an action discriminator whose actions are lifecycle only.
Anything that is behaviour, including schedules, webhooks and any future verb, is a capability reached from inside `execute`.
A fourth tool or a fifth `packages` action is the tripwire, not the solution.

Create exists on the tool rather than as a capability for exactly one reason: its input is the module the host already holds from a previous run, so the model names a run instead of re-emitting code.

No versioning and no import pins, despite the word package.
A mutable published pointer plus republish covers more than it appears to, and a version is close to impossible to remove once anything depends on one.

Type checking runs at publish, not at execute.

### Storage placement

Owner-local durable storage is primary: credentials, host policy, run records, package state.
A shared relational store is provisioned when the first read appears that is keyed by something other than the owner, or that enumerates across owners.
At one owner that set is empty, so it is not provisioned in these three slices.
The MCP OAuth provider's own grant state is the exception, because pre-authentication state cannot be owner-scoped: the grant is how the owner is learned.

### Environments and deployment

Local and production only.
Preview arrives with CI, with new durable object classes rather than transferred ones, so a preview can never reach production state.

Nothing in the execute path reaches a binding from module scope.
Bindings arrive through an explicit interface passed in at the door.
That single rule is what makes the eventual split into separate deployables a configuration change rather than surgery.

Slice 3 introduces the first durable object, which is the moment the deployment-split trigger becomes live: a deploy of the script that owns a durable object class restarts those objects, and stored data survives while in-memory state and in-flight requests do not.

## Testing Decisions

A good test here exercises observable behaviour through a public interface.
For this system that means asserting on the envelope, on what crossed the boundary, and on what did not, rather than on how a module arrived at it.
The most valuable assertions are negative: the value that was not present, the request that was not made, the row that did not decrypt.

Two runners.
Anything touching workerd runs under the Workers vitest pool: the runner, the gateway, durable object storage, and the absence of the parent environment.
Pure logic runs in plain vitest: placeholder parsing, ranking, envelope encoding, error tagging.
End to end is an MCP client harness that completes the authorize flow and calls the three tools, because the consumer of this system is a model over MCP and a browser test would exercise the smaller half.

### Gateway and host policy

- A placeholder is substituted only for a host approved for that specific credential.
- An off-list request is refused before the network call happens, not after.
- A denial carries its approval link, and the credential value appears in neither the error nor the logs nor the run output.
- A credential with no approvals reaches nothing, because empty is the starting state.
- An integration token is attached only after the integration's allowed host set is resolved, and an off-list target throws without the request being made and without the token in the message.
- An import-boundary test asserts that the host policy write path is not reachable from the capability layer, so the invariant is enforced by the build rather than by review.

### Runner and virtual module builder

- A module that throws, one that hangs, and one that loops forever each fail without taking down the server.
- The isolate has no parent environment, asserted by attempting to reach one.
- An uncaught throw arrives in the envelope with its tag intact.
- An ungranted capability fails at the import line, not at the call.
- The generated module exposes exactly the resolved capability set and nothing else.

### Owner context and credential store

- An owner id cannot be constructed from anything but an authenticated request.
- A capability handler ignores an owner id passed as an argument and uses the request's.
- A ciphertext copied into another owner's row fails to decrypt.
- A bearer whose audience does not match the origin is rejected.

### Discovery, registry, run records, packages

- Searching by intent finds the same thing as searching by name.
- A package ranks above a general primitive when both match equally.
- Every result states whether it is a capability or a package.
- The default response stays inside its size budget; detail is a separate call.
- Publishing a package whose declared export does not exist fails the publish rather than the run.
- A failed publish check leaves the previous version serving.
- A failure is diagnosable from its run record alone, tested by reconstructing the cause without re-running.

### Prior art

None.
The repository is empty, so these are the first tests and they become the prior art.
The one convention to establish deliberately on the first commit: negative assertions name what must not have happened, so a later reader can see the invariant rather than infer it.

## Out of Scope

- Any web application.
  The first screen the system genuinely needs is host approval, and until Slice 2 exists there is nothing to approve.
  The operator command covers approval for these three slices.
- Any conversational client of ours, and any desktop or mobile application.
  A real MCP host is the client, and one we built would connect the same way, so building it later costs nothing that building it now would save.
- Subagent infrastructure.
  Several concurrent agents already work, because nothing is keyed on the user and nothing lives on the connection.
- A shared relational store.
- A second deployable.
  The seam is named and kept clean; the split waits for its trigger.
- Composition across owners, hosted package pages, inbound webhooks, scheduled work, and durable workflows.
- Vector search.
  Lexical ranking until three real queries have failed on it.
- Versioning and import pins, in any form.
- Plans, quotas beyond the runaway backstop, roles, entitlements, feature flags, and admin surfaces.
- Community, sharing, a public registry, and anything resembling a marketplace.
- Any code from `kentcdodds/kody`.
  Its security invariants were read as findings and are restated in our own words where they appear above.
  The repository is neither copied nor vendored, and this holds for the whole life of the project.

## Further Notes

### Risks worth a spike in the first week

**Worker Loader is open beta.**
The most load-bearing dependency in the system is not generally available.
Spiked on 2026-08-31 and confirmed as a binding on production, so the bet is narrower than it was.
The trigger that would reopen it is named under Slice 1 rather than left as an intention.

**Type checking at publish requires the compiler to run inside a Worker.**
TypeScript is pure JavaScript so it will run, but it is a large dependency against the script size limit, and a written decision already depends on it.

**Sandbox bundling may not be needed at all.**
Worker Loader takes a module map and resolves imports among its members, so a multi-file package may need no bundler.
Verify before choosing one, and note that a native bundler cannot run in a Worker regardless.
Slice 1 needs none, so the question is deferred rather than answered, and the trigger to answer it is the first sandbox module with a bare npm specifier.

### Accepted residual risks

There is no general SSRF denylist on sandbox fetch.
Credential-bearing requests are constrained by per-credential host allowlists; requests carrying no credential rely on the platform egress model.
Adopted consciously so that a protection nobody built is not later assumed to exist.

### Open questions carried forward

These were surfaced during the architecture review and are not settled by this spec.

1. Where the gateway lives once the deployment splits, and how a smoke test states which script it actually proved.
2. Whether a remote MCP server's tools can be resolved before the virtual module is generated, so that import-time failure survives.
3. Whether acting as another server's MCP client forces owner-local connection state, and whether that is a different question from our own inbound surface being stateless.
4. Whether `packages` ever acquires a network path, which would be the signal it has stopped being lifecycle.

The four Slice 1 carried, surfaced by the Worker Loader spike rather than by the review, were closed on 2026-08-31.
What replaced them is written with that slice: two of them became decisions, one became an experiment that stops the slice if it fails, and one became an experiment whose bad answer ships as a hole with the Slice 2 ceiling under it.

### Vocabulary

There is no `CONTEXT.md` yet.
This spec uses the plan's terms: owner, capability, package, isolate, gateway, placeholder, virtual module, run record, envelope, publish, slice.
The first of these to be contested is the one to write the glossary around.
