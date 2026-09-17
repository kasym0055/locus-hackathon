import { describe, expect, it } from "vitest";
import { discoveryDeadlineAt, makeContext, remainingMs } from "@/server/limits";

describe("remainingMs", () => {
  it("does not replenish the absolute request deadline", () => {
    const ctx = makeContext({
      requestId: "r",
      sessionId: "s",
      ipHash: "i",
      signal: new AbortController().signal,
      now: 1_000,
    });

    expect(remainingMs(ctx, 26_000)).toBe(2_000);
    expect(remainingMs(ctx, 29_000)).toBe(0);
  });
  it("reserves ten seconds for preparation and assessment without exceeding a shorter outer deadline", () => {
    const ctx = makeContext({ requestId: "r", sessionId: "s", ipHash: "i",
      signal: new AbortController().signal, now: 1_000 });

    expect(discoveryDeadlineAt(ctx)).toBe(18_000);
    expect(discoveryDeadlineAt({ ...ctx, deadlineAt: 12_000 })).toBe(12_000);
  });
});
