/**
 * The runner: code, a module map and an owner in; an outcome out.
 *
 * One runner sits behind every entry point - `execute` now, schedules and
 * webhooks later - and authorization differs at the door, never in here.
 *
 * The isolate is named for the owner and the run, because `LOADER.get` caches
 * by name and the obvious warm-start optimisation - naming it after a hash of
 * the code - would put two owners in one isolate. The boundary is
 * `globalOutbound: null` plus the `env` that is never passed; `limits` is
 * passed and never relied on, per the spike finding that it does not bound a
 * busy loop. A fixed host-side timeout races the call instead: it stops the
 * waiting and does not claim to have stopped the isolate.
 *
 * The sandbox's report is parsed with `Schema` rather than trusted. A
 * malformed body is likely and a lying one is not, because the code is the
 * owner's own agent writing to the owner.
 */
import { Data, Effect, Schema } from "effect";
import type { Owner } from "../identity/index.ts";
import type { Failure } from "../kernel/index.ts";
import type { ModuleMap } from "./VirtualModule.ts";

export interface RunnerBindings {
  readonly LOADER: WorkerLoader;
  /**
   * The host-side timeout, as configuration through the door like everything
   * else, so the tests can wait milliseconds where production waits seconds
   * without a test-only code path in the deployed worker.
   */
  readonly EXECUTE_TIMEOUT_MS: string;
}

/** Matches the deployed worker; the loaded isolate states its own. */
const COMPATIBILITY_DATE = "2026-08-31";

/** Passed, never relied on: the spike showed cpuMs not bounding a busy loop. */
const LIMITS = { cpuMs: 5_000 };

/**
 * What a run may say. Result and logs return to a model's context, so both
 * are bounded; the asymmetry between the two is deliberate. A result that
 * quietly lost its tail makes a model confidently wrong, so an oversized
 * result is a failure and is never truncated. A run that succeeded should not
 * be failed for being chatty, so oversized logs are truncated with a marker
 * naming what was dropped.
 */
const RESULT_CEILING_BYTES = 32_768;
const LOGS_CEILING_BYTES = 8_192;

/** The run did not finish in time. The isolate may still be burning: this
 * failure stops the waiting, it does not claim to have stopped the run. */
export class ExecutionTimedOut extends Data.TaggedError("ExecutionTimedOut")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The isolate could not be booted or reached at all. Ours, not the code's. */
export class SandboxUnavailable extends Data.TaggedError("SandboxUnavailable")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "now";
}

/**
 * The platform stopped the run for burning its whole CPU budget. The code's
 * fault, not ours, and repeating the same code cannot help - which is exactly
 * what the tag and the classification must say, because the first production
 * runaway came back as `SandboxUnavailable`/`now` and read as an infra fault
 * inviting a retry of an infinite loop.
 */
export class CpuTimeExceeded extends Data.TaggedError("CpuTimeExceeded")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * Classify a rejected sandbox call.
 *
 * SHORTCUT, recorded here because there is nowhere better: the only signal is
 * workerd's message string, so this matches on it. Observed on production on
 * 2026-08-31: "Error: Worker exceeded CPU time limit." - which is also the
 * production answer to the spec's runaway question, since the invocation died
 * alone and the host kept serving. Under miniflare this branch is unreachable
 * (a busy loop crashes workerd instead of rejecting), so it is proved in a
 * unit test rather than a worker test.
 */
export const rejectionFailure = (cause: unknown): CpuTimeExceeded | SandboxUnavailable =>
  /exceeded CPU time limit/i.test(String(cause))
    ? new CpuTimeExceeded({
        message:
          "the run burned its whole CPU budget and was stopped by the platform. " +
          "Repeating the same code cannot help; make it do less work.",
      })
    : new SandboxUnavailable({ message: `the sandbox could not be reached: ${String(cause)}` });

/** The sandbox answered with something the report schema refuses. */
export class MalformedSandboxReport extends Data.TaggedError("MalformedSandboxReport")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** The run finished, but the result cannot come home whole. */
export class ResultTooLarge extends Data.TaggedError("ResultTooLarge")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

const SandboxReport = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Any,
    logs: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ tag: Schema.String, message: Schema.String }),
    logs: Schema.Array(Schema.String),
  }),
]);

const decodeReport = Schema.decodeUnknownEffect(SandboxReport);

/** What `execute` hands back on success. Logs only when there were any. */
export interface RunOutcome {
  readonly result: unknown;
  readonly logs?: readonly string[];
}

/**
 * Cut logs to their ceiling from the front, so what survives is the earliest
 * output - the part that explains how the run got where it got - and the
 * marker names exactly what was dropped.
 */
const boundedLogs = (logs: readonly string[]): readonly string[] => {
  const kept: string[] = [];
  let spent = 0;
  for (const line of logs) {
    spent += line.length + 2;
    if (spent > LOGS_CEILING_BYTES) {
      kept.push(
        `[${logs.length - kept.length} more log entries dropped: the log ceiling is ${LOGS_CEILING_BYTES} bytes]`,
      );
      return kept;
    }
    kept.push(line);
  }
  return kept;
};

/**
 * A failure reported by the sandbox keeps the tag the thrown value carried -
 * the boundary must not flatten what went wrong - and brings the run's logs
 * home with it, because a failure without its output is not debuggable.
 */
const sandboxFailure = (tag: string, message: string, logs: readonly string[]): Failure.OptiError => ({
  _tag: tag,
  message,
  retry: "never",
  ...(logs.length === 0 ? {} : { logs: boundedLogs(logs) }),
});

export const run = (
  bindings: RunnerBindings,
  ownerId: Owner.OwnerId,
  modules: ModuleMap,
): Effect.Effect<RunOutcome, Failure.OptiError> =>
  Effect.gen(function* () {
    // Named for the owner and the run: no two runs share an isolate, and no
    // two owners can, whatever code they submitted.
    const isolateName = `${ownerId}:${crypto.randomUUID()}`;

    const stub = bindings.LOADER.get(isolateName, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "main.js",
      modules,
      // The boundary. No env is passed, so there is no parent environment to
      // reach; null outbound closes fetch, sockets and node:net in one gate.
      globalOutbound: null,
      limits: LIMITS,
    }));

    const response = yield* Effect.tryPromise({
      try: () => stub.getEntrypoint().fetch("https://sandbox.invalid/"),
      catch: rejectionFailure,
    }).pipe(
      Effect.timeout(Number(bindings.EXECUTE_TIMEOUT_MS)),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new ExecutionTimedOut({
            message:
              `the run did not finish within ${bindings.EXECUTE_TIMEOUT_MS}ms and has been abandoned. ` +
              "Repeating the same code cannot help; make it finish sooner.",
          }),
      ),
    );

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new MalformedSandboxReport({ message: "the sandbox answered with something that was not JSON" }),
    });

    const report = yield* decodeReport(body).pipe(
      Effect.mapError(
        () => new MalformedSandboxReport({ message: "the sandbox answered with something that was not a report" }),
      ),
    );

    if (!report.ok) {
      return yield* Effect.fail(sandboxFailure(report.error.tag, report.error.message, report.logs));
    }

    const size = JSON.stringify(report.value)?.length ?? 0;
    if (size > RESULT_CEILING_BYTES) {
      // Never truncated, and deliberately not included: a model reasoning
      // over a result that quietly lost its tail is confidently wrong.
      return yield* Effect.fail(
        sandboxFailure(
          "ResultTooLarge",
          `the result is ${size} bytes and the ceiling is ${RESULT_CEILING_BYTES}. Return less, or return a summary.`,
          report.logs,
        ),
      );
    }

    return {
      result: report.value,
      ...(report.logs.length === 0 ? {} : { logs: boundedLogs(report.logs) }),
    };
  });
