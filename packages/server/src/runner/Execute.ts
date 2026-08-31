/**
 * The `execute` tool: code and nothing else, so there is no second path for
 * data to reach the sandbox before anything needs one.
 *
 * The tool counts the execution at the door before the run boots, resolves
 * the owner's capability set and published packages, has the virtual module
 * builder turn them into a module map, and hands the map to the runner along
 * with the seam: the gateway loopback, sealed with props the host set at the
 * door. Before the envelope leaves, every surface of it is redacted against
 * the owner's credential values, because a denial must not leak the thing it
 * protects.
 *
 * The record is written before the response leaves, which is what makes
 * "that worked, save it" safe to say immediately. When the run succeeded and
 * the record write failed, the run's real result returns with an explicit
 * no-record marker: the owner asked for the run, not the bookkeeping, and
 * failing a successful run would invite a duplicate retry of side effects
 * that already happened. A run refused at the budget door never booted, so
 * it is not a run and gets no record.
 */
import { Data, Effect, Schema } from "effect";
import type { GatewayProps } from "../gateway/Gateway.ts";
import { redactText, redactValue } from "../gateway/Redact.ts";
import type { Owner } from "../identity/index.ts";
import { Envelope, Failure } from "../kernel/index.ts";
import { builtIns, sandboxPackages } from "../registry/Registry.ts";
import { type OwnerStore, type PutRecordVerdict, storeFor } from "../store/OwnerStore.ts";
import { RECORD_LOGS_CEILING_BYTES } from "../store/RunRecords.ts";
import { type OwnerVault, vaultFor } from "../vault/OwnerVault.ts";
import * as Runner from "./Runner.ts";
import * as VirtualModule from "./VirtualModule.ts";

export interface ExecuteBindings extends Runner.RunnerBindings {
  readonly OWNER_VAULT: DurableObjectNamespace<OwnerVault>;
  readonly OWNER_STORE: DurableObjectNamespace<OwnerStore>;
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
    '{code}: a complete ES module that default-exports an async function returning a JSON-serializable value. Import capabilities from "opti:capabilities" and your packages from "opti:packages/<name>". ' +
    "No environment; console output comes back as logs, and every response carries the run id of its record.",
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

/** What `execute` hands back on success. Logs only when there were any, and
 * `unrecorded` only when the record write failed: an absent field means the
 * boring default, which here is "the record exists". */
export interface RunOutcome {
  readonly runId: string;
  readonly result: unknown;
  readonly logs?: readonly string[];
  readonly unrecorded?: string;
}

export const run = (
  bindings: ExecuteBindings,
  context: ExecuteContext,
  input: typeof parameters.Type,
): Effect.Effect<RunOutcome, Failure.OptiError> =>
  Effect.gen(function* () {
    const vault = vaultFor(bindings.OWNER_VAULT, context.ownerId);
    const store = storeFor(bindings.OWNER_STORE, context.ownerId);

    // Counted at the door, before the run boots, so a refused run costs no
    // isolate and the counter still moved.
    const budget = yield* Effect.promise(() => vault.countExecution(Number(bindings.EXECUTION_BUDGET)));
    if (budget.exhausted) {
      return yield* new ExecutionBudgetExhausted({
        message: `the daily execution budget is spent. It resets at ${budget.resetsAt}.`,
      });
    }

    const runId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const published = yield* Effect.promise(async () => await store.listPublished());

    const report = yield* Runner.run(
      bindings,
      context.ownerId,
      runId,
      VirtualModule.build(builtIns, sandboxPackages(published), input.code),
      context.gateway({ props: { ownerId: context.ownerId, runId, origin: context.origin } }),
    );

    // Redaction, envelope-side: every surface that leaves - result, logs,
    // failure messages - is scanned against all of the owner's values. An
    // API echoing a credential into the sandbox comes home as
    // `[redacted:name]`, whatever route it took. The record gets the same
    // treatment, because a record is also a surface that leaves.
    const values = yield* Effect.promise(() => vault.allValues(context.ownerId));
    const redactedLogs = report.logs.map((line) => redactText(values, line));
    const envelopeLogs = Runner.boundedLogs(redactedLogs, Runner.LOGS_CEILING_BYTES);

    // The record holds the full envelope as it leaves, under the record's
    // own larger log ceiling, and the trail the gateway buffered.
    const record = (
      envelope: Envelope.Envelope<RunOutcome>,
      outcome: "success" | "failure",
    ): Effect.Effect<PutRecordVerdict> =>
      Effect.promise(async () =>
        store.putRecord({
          runId,
          createdAt,
          source: "execute",
          outcome,
          code: redactText(values, input.code),
          envelopeJson: JSON.stringify(envelope),
          logs: Runner.boundedLogs(redactedLogs, RECORD_LOGS_CEILING_BYTES),
          timings: report.timings,
        }),
      );

    if (!report.outcome.ok) {
      const error = report.outcome.error;
      const failure: Failure.OptiError = {
        _tag: error.tag,
        message: redactText(values, error.message),
        retry: error.retry,
        ...(error.action === undefined ? {} : { action: error.action }),
        ...(envelopeLogs.length === 0 ? {} : { logs: envelopeLogs }),
        // The record is the debugging handle, so the failure carries the
        // run id like every response.
        runId,
      };
      yield* record(Envelope.fail(Failure.toFailure(failure)), "failure");
      return yield* Effect.fail(failure);
    }

    const success: RunOutcome = {
      runId,
      result: redactValue(values, report.outcome.result),
      ...(envelopeLogs.length === 0 ? {} : { logs: envelopeLogs }),
    };
    const verdict = yield* record(Envelope.succeed(success), "success");
    return verdict.written
      ? success
      : {
          ...success,
          // The gap is visible rather than silent: the run's result is real,
          // the bookkeeping is not, and retrying the run would repeat side
          // effects that already happened.
          unrecorded: `no run record exists for this run: ${verdict.message}`,
        };
  });
