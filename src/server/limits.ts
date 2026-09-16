import type { RunContext, RunContextInput } from "@/server/contracts";

export const REQUEST_DEADLINE_MS = 27_000;

export function makeContext(input: RunContextInput): RunContext {
  return {
    requestId: input.requestId,
    sessionId: input.sessionId,
    ipHash: input.ipHash,
    signal: input.signal,
    startedAt: input.now,
    deadlineAt: input.now + REQUEST_DEADLINE_MS,
  };
}

export function remainingMs(ctx: RunContext, now: number): number {
  return Math.max(0, ctx.deadlineAt - now);
}
