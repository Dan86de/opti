/**
 * The `execute` tool: code and nothing else, so there is no second path for
 * data to reach the sandbox before anything needs one.
 *
 * The tool counts the execution at the door before the run boots, resolves
 * the owner's capability set, has the virtual module builder turn it into a
 * module map, and hands the map to the runner along with the seam: the
 * gateway loopback, sealed with props the host set at the door. Before the
 * envelope leaves, every surface of it is redacted against the owner's
 * credential values, because a denial must not leak the thing it protects.
 * The grant is resolved here, at the tool, and the runner runs whatever map
 * it is given - authorization at the door, never inside.
 */
import { Data, Effect, Exit, Schema } from "effect";
import type { GatewayProps } from "../gateway/Gateway.ts";
import { redactText, redactValue } from "../gateway/Redact.ts";
import type { Owner } from "../identity/index.ts";
import type { Failure } from "../kernel/index.ts";
import { builtIns } from "../registry/Registry.ts";
import { type OwnerVault, vaultFor } from "../vault/OwnerVault.ts";
import * as Runner from "./Runner.ts";
import * as VirtualModule from "./VirtualModule.ts";

export interface ExecuteBindings extends Runner.RunnerBindings {
  readonly OWNER_VAULT: DurableObjectNamespace<OwnerVault>;
  /** The daily execution ceiling, through the door like every number. */
  readonly EXECUTION_BUDGET: string;
}

/** The daily execution ceiling. Retry `after`: the message names the reset. */
export class ExecutionBudgetExhausted extends Data.TaggedError("ExecutionBudgetExhausted")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "after";
}

export const parameters = Schema.Struct({
  code: Schema.String,
});

export const tool = {
  name: "execute",
  description:
    "Run a JavaScript module in a fresh sandbox and get its return value. " +
    '{code}: a complete ES module that default-exports an async function returning a JSON-serializable value. Import the capabilities search names from "opti:capabilities". ' +
    "No environment; console output comes back as logs.",
  parametersSchema: parameters,
};

/**
 * Who is asking and where the seam leads. Built at the door by the entry
 * point, because `ctx.exports` and the request's origin exist only there.
 */
export interface ExecuteContext {
  readonly ownerId: Owner.OwnerId;
  readonly origin: string;
  /** `ctx.exports.Gateway`, kept callable so each run seals its own props. */
  readonly gateway: (opts: { readonly props: GatewayProps }) => Fetcher;
}

/** A failure with its message and logs scrubbed, tag and action intact. */
const redactedFailure = (values: Readonly<Record<string, string>>, error: Failure.OptiError): Failure.OptiError => ({
  ...error,
  message: redactText(values, error.message),
  ...(error.logs === undefined ? {} : { logs: error.logs.map((line) => redactText(values, line)) }),
});

export const run = (
  bindings: ExecuteBindings,
  context: ExecuteContext,
  input: typeof parameters.Type,
): Effect.Effect<Runner.RunOutcome, Failure.OptiError> =>
  Effect.gen(function* () {
    const vault = vaultFor(bindings.OWNER_VAULT, context.ownerId);

    // Counted at the door, before the run boots, so a refused run costs no
    // isolate and the counter still moved.
    const budget = yield* Effect.promise(() => vault.countExecution(Number(bindings.EXECUTION_BUDGET)));
    if (budget.exhausted) {
      return yield* new ExecutionBudgetExhausted({
        message: `the daily execution budget is spent. It resets at ${budget.resetsAt}.`,
      });
    }

    const exit = yield* Effect.exit(
      Runner.run(bindings, context.ownerId, VirtualModule.build(builtIns, input.code), (runId) =>
        context.gateway({ props: { ownerId: context.ownerId, runId, origin: context.origin } }),
      ),
    );

    // Redaction, envelope-side: every surface that leaves - result, logs,
    // failure messages - is scanned against all of the owner's values. An
    // API echoing a credential into the sandbox comes home as
    // `[redacted:name]`, whatever route it took.
    const values = yield* Effect.promise(() => vault.allValues(context.ownerId));
    if (Exit.isSuccess(exit)) {
      const outcome = exit.value;
      return {
        result: redactValue(values, outcome.result),
        ...(outcome.logs === undefined ? {} : { logs: outcome.logs.map((line) => redactText(values, line)) }),
      };
    }
    return yield* Effect.failCause(exit.cause).pipe(Effect.mapError((error) => redactedFailure(values, error)));
  });
