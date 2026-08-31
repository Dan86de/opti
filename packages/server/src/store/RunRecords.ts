/**
 * The run records module of the owner store: write a record, query by time,
 * source and outcome, get one by id - and the trail buffer.
 *
 * The record is written before `execute` responds. A write to the owner's own
 * object is neither synchronous-on-a-relational-hot-path nor fire-and-forget,
 * and writing first is what makes "that worked, save it" safe to say
 * immediately: create-from-run never races the owner's own storage.
 *
 * The trail is buffered here rather than on the gateway entrypoint, and that
 * is a recorded deviation from the interview's wording: workerd builds a
 * fresh entrypoint instance per call, so "the per-run gateway instance
 * buffers the trail" has no instance to buffer on. The buffer lives in the
 * store keyed by the run id - which the gateway holds in its props - and
 * `putRecord` consumes it in the same transaction that writes the record.
 */
import { Data } from "effect";
import type { Failure } from "../kernel/index.ts";

/**
 * The record's own logs ceiling, larger than the envelope's 8KB: that number
 * is a context-budget bound and not a truth bound, and the record is read by
 * whoever is debugging, not paid for on every conversation.
 */
export const RECORD_LOGS_CEILING_BYTES = 65_536;

/** One line per outbound request is still unbounded when a loop hammers
 * denials, so the buffer has a ceiling and the cut announces itself. */
export const TRAIL_BOUND = 200;

/** Buffered trail lines from runs that never wrote a record - a host that
 * died mid-run - are garbage; anything older than this is swept. */
const TRAIL_SWEEP_MS = 24 * 60 * 60 * 1000;

/** One outbound request as the record keeps it: never bodies, never values. */
export interface TrailLine {
  readonly method: string;
  readonly host: string;
  readonly status: number;
  readonly durationMs: number;
  /** The failure tag, present only when the gateway denied the request. */
  readonly denied?: string;
}

export interface PhaseTimings {
  /** Sandbox-reported: how long the submitted module took to load. */
  readonly bootMs?: number;
  /** Sandbox-reported: how long the default export took to run. */
  readonly executeMs?: number;
  /** Host-measured, around the whole call. */
  readonly totalMs: number;
}

export type RunOutcomeKind = "success" | "failure";

/** What `putRecord` takes: everything but the trail, which it consumes from
 * the buffer itself so the runner never has to carry it. */
export interface RunRecordInput {
  readonly runId: string;
  readonly createdAt: string;
  /** `execute` on every record in this slice; schedules and webhooks name
   * themselves when they exist. */
  readonly source: string;
  readonly outcome: RunOutcomeKind;
  readonly code: string;
  /**
   * The full envelope as it left, already redacted, serialized: the RPC
   * boundary's types reject arbitrary values, and every reader either
   * splices the record onward as JSON or parses it whole anyway.
   */
  readonly envelopeJson: string;
  readonly logs: readonly string[];
  readonly timings: PhaseTimings;
}

/** The record as it reads back: the envelope parsed, the trail attached. */
export interface RunRecord extends Omit<RunRecordInput, "envelopeJson"> {
  readonly envelope: unknown;
  readonly trail: readonly TrailLine[];
  /** Present only when the trail buffer hit its ceiling mid-run. */
  readonly trailTruncated?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly createdAt: string;
  readonly source: string;
  readonly outcome: RunOutcomeKind;
  readonly totalMs: number;
}

export interface RunQuery {
  readonly since?: string;
  readonly until?: string;
  readonly source?: string;
  readonly outcome?: RunOutcomeKind;
  readonly limit?: number;
}

const QUERY_DEFAULT_LIMIT = 20;
const QUERY_MAX_LIMIT = 100;

export class NoSuchRun extends Data.TaggedError("NoSuchRun")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export const createTables = (sql: SqlStorage): void => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS run_records (" +
      "run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source TEXT NOT NULL, " +
      "outcome TEXT NOT NULL, total_ms INTEGER NOT NULL, record TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS trail_buffer (run_id TEXT NOT NULL, created_at TEXT NOT NULL, line TEXT NOT NULL)",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS trail_dropped (run_id TEXT PRIMARY KEY, dropped INTEGER NOT NULL)");
};

/** One line into the buffer, bounded. Past the bound the drop is counted
 * rather than silent, so the record can name what the trail lost. */
export const appendTrail = (sql: SqlStorage, runId: string, line: TrailLine, now: Date): void => {
  const buffered = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM trail_buffer WHERE run_id = ?", runId).one().n;
  if (buffered >= TRAIL_BOUND) {
    sql.exec(
      "INSERT INTO trail_dropped (run_id, dropped) VALUES (?, 1) " +
        "ON CONFLICT(run_id) DO UPDATE SET dropped = dropped + 1",
      runId,
    );
    return;
  }
  sql.exec(
    "INSERT INTO trail_buffer (run_id, created_at, line) VALUES (?, ?, ?)",
    runId,
    now.toISOString(),
    JSON.stringify(line),
  );
};

/** Consume the buffered trail for one run, oldest first. */
const takeTrail = (sql: SqlStorage, runId: string): { trail: TrailLine[]; dropped: number } => {
  const lines = sql
    .exec<{ line: string }>("SELECT line FROM trail_buffer WHERE run_id = ? ORDER BY rowid", runId)
    .toArray()
    .map((row): TrailLine => JSON.parse(row.line));
  const droppedRows = sql
    .exec<{ dropped: number }>("SELECT dropped FROM trail_dropped WHERE run_id = ?", runId)
    .toArray();
  sql.exec("DELETE FROM trail_buffer WHERE run_id = ?", runId);
  sql.exec("DELETE FROM trail_dropped WHERE run_id = ?", runId);
  return { trail: lines, dropped: droppedRows[0]?.dropped ?? 0 };
};

export const putRecord = (sql: SqlStorage, input: RunRecordInput, now: Date): void => {
  // Sweep buffers from runs whose host died before writing a record: they
  // belong to nobody and would otherwise accumulate forever.
  const horizon = new Date(now.getTime() - TRAIL_SWEEP_MS).toISOString();
  sql.exec("DELETE FROM trail_buffer WHERE created_at < ?", horizon);

  const { trail, dropped } = takeTrail(sql, input.runId);
  const { envelopeJson, ...rest } = input;
  const record: RunRecord = {
    ...rest,
    envelope: JSON.parse(envelopeJson),
    trail,
    ...(dropped === 0
      ? {}
      : { trailTruncated: `${dropped} more requests dropped: the trail ceiling is ${TRAIL_BOUND} lines` }),
  };
  sql.exec(
    "INSERT INTO run_records (run_id, created_at, source, outcome, total_ms, record) VALUES (?, ?, ?, ?, ?, ?)",
    record.runId,
    record.createdAt,
    record.source,
    record.outcome,
    Math.round(record.timings.totalMs),
    JSON.stringify(record),
  );
};

/**
 * Summaries, newest first, bounded. ISO-8601 strings sort chronologically as
 * text, which is what lets `since`/`until` be plain comparisons.
 */
export const query = (sql: SqlStorage, filter: RunQuery): readonly RunSummary[] => {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (filter.since !== undefined) {
    clauses.push("created_at >= ?");
    values.push(filter.since);
  }
  if (filter.until !== undefined) {
    clauses.push("created_at <= ?");
    values.push(filter.until);
  }
  if (filter.source !== undefined) {
    clauses.push("source = ?");
    values.push(filter.source);
  }
  if (filter.outcome !== undefined) {
    clauses.push("outcome = ?");
    values.push(filter.outcome);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const limit = Math.max(1, Math.min(filter.limit ?? QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT));
  return sql
    .exec<{ run_id: string; created_at: string; source: string; outcome: RunOutcomeKind; total_ms: number }>(
      `SELECT run_id, created_at, source, outcome, total_ms FROM run_records${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...values,
      limit,
    )
    .toArray()
    .map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      source: row.source,
      outcome: row.outcome,
      totalMs: row.total_ms,
    }));
};

/** The record as stored: JSON text, spliced onward or parsed by the caller.
 * Text because a typed record cannot cross the RPC boundary whole. */
export const get = (sql: SqlStorage, runId: string): string | null => {
  const rows = sql.exec<{ record: string }>("SELECT record FROM run_records WHERE run_id = ?", runId).toArray();
  return rows[0]?.record ?? null;
};
