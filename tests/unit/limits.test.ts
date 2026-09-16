import { describe, expect, it } from "vitest";
import { makeContext, remainingMs } from "@/server/limits";

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
});
