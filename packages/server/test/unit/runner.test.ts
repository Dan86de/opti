/**
 * Classifying a rejected sandbox call is pure logic, proved here because the
 * interesting rejection cannot be produced locally: under miniflare a busy
 * loop crashes workerd instead of rejecting the call (the recorded spike
 * finding), while Cloudflare's loader rejects it with a CPU-limit error -
 * observed on production, 2026-08-31, through a real MCP host.
 */
import { describe, expect, it } from "vitest";
import { rejectionFailure } from "../../src/runner/Runner.ts";

describe("a rejected sandbox call", () => {
  it("blames the code, not the infrastructure, when the CPU budget burned", async () => {
    const failure = rejectionFailure(new Error("Worker exceeded CPU time limit."));

    // Production's answer to the runaway question: the platform stops the
    // run and the invocation dies alone. That is the caller's code at fault,
    // so the tag must not read as an infra problem - and retrying the same
    // loop cannot help, so it must not say "now".
    expect(failure).toMatchObject({ _tag: "CpuTimeExceeded", retry: "never" });
    expect(failure.message).toContain("CPU");
  });

  it("keeps everything else a reachability problem worth retrying", async () => {
    const failure = rejectionFailure(new Error("internal error"));

    expect(failure).toMatchObject({ _tag: "SandboxUnavailable", retry: "now" });
  });
});
