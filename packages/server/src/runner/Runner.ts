/**
 * The runner: code, a module map and an owner in; a report out.
 *
 * One runner sits behind every entry point - `execute` now, the publish boot
 * check, schedules and webhooks later - and authorization differs at the
 * door, never in here.
 *
 * The isolate is named for the owner and the run, because `LOADER.get` caches
 * by name and the obvious warm-start optimisation - naming it after a hash of
 * the code - would put two owners in one isolate. The boundary is
 * `globalOutbound` plus the `env` that is never passed: since Slice 2 the
 * outbound is the fetch gateway rather than `null`, so every way out of the
 * isolate asks the gateway. `limits` is passed and never relied on, per the
 * spike finding that it does not bound a busy loop. A fixed host-side timeout
 * races the call instead: it stops the waiting and does not claim to have
 * stopped the isolate.
 *
 * The report never throws: since Slice 3 every run - failed ones especially -
 * gets a run record, and a record needs the logs and the phase timings
 * whichever way the run went. The caller decides what a failure becomes.
 *
 * The sandbox's report is parsed with `Schema` rather than trusted. A
 * malformed body is likely and a lying one is not, because the code is the
 * owner's own agent writing to the owner.
 */
import { Cause, Data, Effect, Schema } from "effect";
import type { Owner } from "../identity/index.ts";
import { Failure } from "../kernel/index.ts";
import type { PhaseTimings } from "../store/RunRecords.ts";
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
 * What a run may say into a model's context. The result and the logs are both
 * bounded; the asymmetry between the two is deliberate. A result that quietly
 * lost its tail makes a model confidently wrong, so an oversized result is a
 * failure and is never truncated. A run that succeeded should not be failed
 * for being chatty, so oversized logs are truncated with a marker naming what
 * was dropped. The run record applies its own larger log ceiling.
 */
const RESULT_CEILING_BYTES = 32_768;
export const LOGS_CEILING_BYTES = 8_192;

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

const ReportTimings = Schema.Struct({
  bootMs: Schema.optionalKey(Schema.Finite),
  executeMs: Schema.optionalKey(Schema.Finite),
});

const SandboxReport = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Any,
    logs: Schema.Array(Schema.String),
    timings: Schema.optionalKey(ReportTimings),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    // retry and action are what Slice 2's denials travel as: a boundary that
    // flattened them would delete the approval link and the classification.
    // Both optional, because an absent field means the boring default.
    error: Schema.Struct({
      tag: Schema.String,
      message: Schema.String,
      retry: Schema.optionalKey(Schema.Literals(["now", "after", "never"])),
      action: Schema.optionalKey(Schema.Struct({ kind: Schema.String, url: Schema.String })),
    }),
    logs: Schema.Array(Schema.String),
    timings: Schema.optionalKey(ReportTimings),
  }),
]);

const decodeReport = Schema.decodeUnknownEffect(SandboxReport);

/** A failure as the report carries it: data, not a class, because it may
 * have crossed the sandbox boundary as JSON. */
export interface ReportedFailure {
  readonly tag: string;
  readonly message: string;
  readonly retry: Failure.Retry;
  readonly action?: Failure.Action;
}

/**
 * What one run reports, whichever way it went. The logs are raw: the caller
 * applies the envelope ceiling and the record ceiling separately, because
 * 8KB is a context-budget bound and not a truth bound.
 */
export interface RunReport {
  readonly outcome:
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly error: ReportedFailure };
  readonly logs: readonly string[];
  readonly timings: PhaseTimings;
}

/**
 * Cut logs to a ceiling from the front, so what survives is the earliest
 * output - the part that explains how the run got where it got - and the
 * marker names exactly what was dropped.
 */
export const boundedLogs = (logs: readonly string[], ceiling: number): readonly string[] => {
  const kept: string[] = [];
  let spent = 0;
  for (const line of logs) {
    spent += line.length + 2;
    if (spent > ceiling) {
      kept.push(`[${logs.length - kept.length} more log entries dropped: the log ceiling is ${ceiling} bytes]`);
      return kept;
    }
    kept.push(line);
  }
  return kept;
};

const failedReport = (error: ReportedFailure, logs: readonly string[], timings: PhaseTimings): RunReport => ({
  outcome: { ok: false, error },
  logs,
  timings,
});

export const run = (
  bindings: RunnerBindings,
  ownerId: Owner.OwnerId,
  runId: string,
  modules: ModuleMap,
  outbound: Fetcher | null,
): Effect.Effect<RunReport> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    // Named for the owner and the run: no two runs share an isolate, and no
    // two owners can, whatever code they submitted.
    const isolateName = `${ownerId}:${runId}`;

    const stub = bindings.LOADER.get(isolateName, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "main.js",
      modules,
      // The boundary. No env is passed, so there is no parent environment to
      // reach; the outbound Fetcher is the gateway, so fetch, sockets and
      // node:net all ask one gate, and the gate applies policy. The publish
      // boot check passes null: its run needs no way out at all.
      globalOutbound: outbound,
      limits: LIMITS,
    }));

    const attempt = Effect.tryPromise({
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
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json(),
          catch: () => new MalformedSandboxReport({ message: "the sandbox answered with something that was not JSON" }),
        }),
      ),
      Effect.flatMap((body) =>
        decodeReport(body).pipe(
          Effect.mapError(
            () => new MalformedSandboxReport({ message: "the sandbox answered with something that was not a report" }),
          ),
        ),
      ),
    );

    const exit = yield* Effect.exit(attempt);
    const totalMs = Date.now() - startedAt;

    if (exit._tag === "Failure") {
      // A host-side failure: the run's own logs never arrived, and the only
      // timing anybody has is the host's.
      const failure = Failure.toFailure(Cause.squash(exit.cause));
      return failedReport(
        {
          tag: failure.tag,
          message: failure.message,
          retry: failure.retry,
          ...(failure.action === undefined ? {} : { action: failure.action }),
        },
        [],
        { totalMs },
      );
    }

    const report = exit.value;
    const reported = "timings" in report ? report.timings : {};
    const timings: PhaseTimings = {
      ...("bootMs" in reported ? { bootMs: reported.bootMs } : {}),
      ...("executeMs" in reported ? { executeMs: reported.executeMs } : {}),
      totalMs,
    };

    if (!report.ok) {
      return failedReport(
        {
          tag: report.error.tag,
          message: report.error.message,
          retry: "retry" in report.error ? report.error.retry : "never",
          ...("action" in report.error ? { action: report.error.action } : {}),
        },
        report.logs,
        timings,
      );
    }

    const size = JSON.stringify(report.value)?.length ?? 0;
    if (size > RESULT_CEILING_BYTES) {
      // Never truncated, and deliberately not included: a model reasoning
      // over a result that quietly lost its tail is confidently wrong.
      return failedReport(
        {
          tag: "ResultTooLarge",
          message: `the result is ${size} bytes and the ceiling is ${RESULT_CEILING_BYTES}. Return less, or return a summary.`,
          retry: "never",
        },
        report.logs,
        timings,
      );
    }

    return { outcome: { ok: true, result: report.value }, logs: report.logs, timings };
  });
