/**
 * The daily ceilings, bucketed by UTC day.
 *
 * Executions count at the door before the run boots; outbound requests count
 * at the gateway, including denials, because a loop hammering denials is
 * still a runaway. Counting therefore happens before the caller decides
 * anything: this module answers "was that one over the limit", never "may I".
 *
 * No other ceiling - no per-run cap, no concurrency cap - because quotas
 * beyond the runaway backstop are out of scope.
 */
import { Effect } from "effect";

export type CounterKind = "executions" | "fetches";

export interface BudgetState {
  /** True when this count crossed the limit. The caller turns it into the
   * budget failure; the counter keeps counting either way. */
  readonly exhausted: boolean;
  /** When the bucket rolls over: the next UTC midnight, as an instant the
   * failure message can name. */
  readonly resetsAt: string;
}

const day = (now: Date): string => now.toISOString().slice(0, 10);

const nextUtcMidnight = (now: Date): string => {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return midnight.toISOString();
};

export const count = (
  storage: DurableObjectStorage,
  kind: CounterKind,
  limit: number,
  now: Date,
): Effect.Effect<BudgetState> =>
  Effect.promise(async () => {
    const key = `counter:${kind}:${day(now)}`;
    const spent = ((await storage.get<number>(key)) ?? 0) + 1;
    await storage.put(key, spent);
    return { exhausted: spent > limit, resetsAt: nextUtcMidnight(now) };
  });
