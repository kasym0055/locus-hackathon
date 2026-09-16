export interface ProbeFrameCapture {
  frame: number;
  arrivalMs: number;
  serverElapsedMs: number;
  rssBytes: number;
  memoryLimitBytes: number;
  native?: { sourcePixels: number; decodes: number; peakRssBytes: number; rssSamples: number };
  outbound?: { configured: boolean; attempts: number; succeeded: number; failed: number; maxActive: number; maxActivePerOrigin: number };
}

export interface ProbeCapture {
  runs: ProbeFrameCapture[][];
  cancellation: { cancelled: boolean; source: "request" | "stream"; cleanupComplete: boolean; waitTimersCleared: number; outboundAborted: boolean };
}

export interface ProbeAssessment {
  status: "pass" | "inconclusive";
  peakRssBytes: number;
  instances: Array<{ memoryLimitBytes: number; peakRssBytes: number; headroom: number | null }>;
}

const EARLY_FRAME_MAX_MS = 10_000;
const FINAL_FRAME_MIN_MS = 27_000;
const MIN_STREAM_SEPARATION_MS = 17_000;

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assessProbe(capture: ProbeCapture, options: { allowUnknownMemory?: boolean } = {}): ProbeAssessment {
  requireEvidence(capture.runs.length > 0, "probe requires at least one completed run");
  requireEvidence(
    capture.cancellation.cancelled
      && (capture.cancellation.source === "request" || capture.cancellation.source === "stream")
      && capture.cancellation.cleanupComplete
      && capture.cancellation.waitTimersCleared > 0
      && capture.cancellation.outboundAborted,
    "probe requires server-side cancellation cleanup evidence",
  );

  const instances = capture.runs.map((run) => {
    const first = run.find((frame) => frame.frame === 0);
    const final = run.find((frame) => frame.frame === 28);
    requireEvidence(first && final, "probe requires start and final frames");
    requireEvidence(first.arrivalMs <= EARLY_FRAME_MAX_MS, "probe requires an early first frame arrival");
    requireEvidence(final.arrivalMs > FINAL_FRAME_MIN_MS, "probe requires a final arrival beyond 27 seconds");
    requireEvidence(final.arrivalMs - first.arrivalMs >= MIN_STREAM_SEPARATION_MS, "probe stream arrivals are buffered");
    requireEvidence(
      final.native?.sourcePixels === 20_000_000 && final.native.decodes <= 2 && final.native.rssSamples >= 4,
      "probe requires sampled native processing evidence",
    );
    requireEvidence(
      final.outbound?.configured
        && final.outbound.attempts === 6
        && final.outbound.succeeded === 6
        && final.outbound.failed === 0
        && final.outbound.maxActive >= 1
        && final.outbound.maxActive <= 6
        && final.outbound.maxActivePerOrigin >= 1
        && final.outbound.maxActivePerOrigin <= 2,
      "probe requires actual configured outbound attempts, successes, and concurrency evidence",
    );

    const peakRssBytes = Math.max(...run.map((frame) => frame.rssBytes), final.native.peakRssBytes);
    const memoryLimitBytes = final.memoryLimitBytes;
    return {
      memoryLimitBytes,
      peakRssBytes,
      headroom: memoryLimitBytes > 0 ? 1 - peakRssBytes / memoryLimitBytes : null,
    };
  });
  const peakRssBytes = Math.max(...instances.map((instance) => instance.peakRssBytes));
  const unknownMemory = instances.some((instance) => instance.memoryLimitBytes <= 0);
  if (unknownMemory) {
    requireEvidence(options.allowUnknownMemory, "probe requires known host memory settings");
    return { status: "inconclusive", peakRssBytes, instances };
  }
  requireEvidence(instances.every((instance) => instance.headroom !== null && instance.headroom >= 0.25), "probe memory headroom is below 25%");

  return { status: "pass", peakRssBytes, instances };
}
