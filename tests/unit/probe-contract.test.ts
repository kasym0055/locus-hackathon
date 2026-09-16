import { describe, expect, it } from "vitest";
import { assessProbe, type ProbeCapture } from "@/server/probe-contract";

const completeCapture: ProbeCapture = {
  runs: [
    [
      { frame: 0, arrivalMs: 120, serverElapsedMs: 2, rssBytes: 100, memoryLimitBytes: 1_000 },
      { frame: 1, arrivalMs: 1_050, serverElapsedMs: 1_000, rssBytes: 140, memoryLimitBytes: 1_000 },
      {
        frame: 28, arrivalMs: 28_050, serverElapsedMs: 28_000, rssBytes: 200, memoryLimitBytes: 1_000,
        native: { sourcePixels: 20_000_000, decodes: 2, peakRssBytes: 220, rssSamples: 4 },
        outbound: { configured: true, attempts: 6, succeeded: 6, failed: 0, maxActive: 2, maxActivePerOrigin: 2 },
      },
    ],
  ],
  cancellation: { cancelled: true, source: "stream", cleanupComplete: true, waitTimersCleared: 1, outboundAborted: true },
};

describe("assessProbe", () => {
  it("rejects a buffered stream that delivers its first frame only at completion", () => {
    const buffered = structuredClone(completeCapture);
    buffered.runs[0][0].arrivalMs = 28_010;

    expect(() => assessProbe(buffered)).toThrow("early");
  });

  it("requires server-side cancellation cleanup evidence", () => {
    const missingCleanup = structuredClone(completeCapture);
    missingCleanup.cancellation.cleanupComplete = false;

    expect(() => assessProbe(missingCleanup)).toThrow("cancellation");
  });

  it("requires cancellation evidence from the request or stream", () => {
    const unknownSource = structuredClone(completeCapture);
    unknownSource.cancellation.source = "self-test" as never;

    expect(() => assessProbe(unknownSource)).toThrow("cancellation");
  });

  it("reports unknown memory as inconclusive when explicitly allowed", () => {
    const unknownMemory = structuredClone(completeCapture);
    for (const frame of unknownMemory.runs[0]) frame.memoryLimitBytes = 0;

    expect(assessProbe(unknownMemory, { allowUnknownMemory: true }).status).toBe("inconclusive");
  });

  it("requires actual configured outbound successes and measured concurrency", () => {
    const notDispatched = structuredClone(completeCapture);
    notDispatched.runs[0][2].outbound = {
      configured: false, attempts: 0, succeeded: 0, failed: 0, maxActive: 0, maxActivePerOrigin: 0,
    };

    expect(() => assessProbe(notDispatched)).toThrow("outbound");
  });

  it("rejects an instance that has less than 25% memory headroom", () => {
    const lowHeadroom = structuredClone(completeCapture);
    lowHeadroom.runs[0][2].native!.peakRssBytes = 800;

    expect(() => assessProbe(lowHeadroom)).toThrow("headroom");
  });
});
