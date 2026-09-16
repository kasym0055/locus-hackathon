import { createHash, timingSafeEqual } from "node:crypto";
import process from "node:process";

import { after } from "next/server";
import sharp from "sharp";

import { config } from "@/server/config";
import {
  CapabilityStoreFailure,
  productionCapabilityCancellationStore,
  type CancellationRecord,
} from "@/server/capability/cancellation-store";
import type { ProbeFrameCapture } from "@/server/probe-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE_WIDTH = 5_000;
const SOURCE_HEIGHT = 4_000;
const SOURCE_PIXELS = SOURCE_WIDTH * SOURCE_HEIGHT;
const MAX_OUTBOUND_REQUESTS = 6;
const MAX_OUTBOUND_PER_ORIGIN = 2;
const encoder = new TextEncoder();

type NativeProbe = NonNullable<ProbeFrameCapture["native"]> & { hash: string; durationMs: number };
type OutboundProbe = NonNullable<ProbeFrameCapture["outbound"]> & { durationMs: number; aborted: boolean };
type CancellationEvidence = {
  cancelled: boolean;
  source: "request" | "stream";
  cleanupComplete: boolean;
  waitTimersCleared: number;
  outboundAborted: boolean;
};
type ProbeFrame = {
  event: "capability";
  frame: number;
  elapsedMs: number;
  rssBytes: number;
  memoryLimitBytes: number;
  native?: NativeProbe;
  outbound?: OutboundProbe;
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validRunId(value: string | null): value is string {
  return value !== null && /^[a-f0-9-]{36}$/i.test(value);
}

function waitUntil(startedAt: number, targetMs: number, signal: AbortSignal, onCleared: () => void): Promise<void> {
  const remaining = Math.max(0, targetMs - (Date.now() - startedAt));
  if (signal.aborted || remaining === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, remaining);
    const onAbort = () => cleanup();
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      onCleared();
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runNativeProbe(sampleRss: () => void): Promise<NativeProbe> {
  const startedAt = Date.now();
  sampleRss();
  const raster = await sharp({
    create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: "#2450a4" },
  }).png().toBuffer();
  sampleRss();
  const decoded = await Promise.all(
    Array.from({ length: 2 }, async () => {
      const output = await sharp(raster).resize({ width: 1_600 }).raw().toBuffer();
      sampleRss();
      return output;
    }),
  );
  sampleRss();
  const hash = createHash("sha256").update(decoded[0]).digest("hex");

  return { hash, durationMs: Date.now() - startedAt, decodes: decoded.length, sourcePixels: SOURCE_PIXELS, peakRssBytes: 0, rssSamples: 0 };
}

async function runOutboundProbe(signal: AbortSignal): Promise<OutboundProbe> {
  const endpoint = config.capabilityProbe.endpoint;
  if (!endpoint) return { configured: false, attempts: 0, succeeded: 0, failed: 0, maxActive: 0, maxActivePerOrigin: 0, durationMs: 0, aborted: signal.aborted };

  const startedAt = Date.now();
  let cursor = 0;
  let attempts = 0;
  let succeeded = 0;
  let failed = 0;
  let active = 0;
  let maxActive = 0;
  let maxActivePerOrigin = 0;
  let aborted = signal.aborted;
  const jobs = Array.from({ length: MAX_OUTBOUND_REQUESTS }, () => async () => {
    if (signal.aborted) return;
    attempts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    maxActivePerOrigin = Math.max(maxActivePerOrigin, active);
    try {
      const response = await fetch(endpoint, { method: "HEAD", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      if (response.ok) succeeded += 1;
      else failed += 1;
      await response.body?.cancel();
    } catch {
      failed += 1;
      aborted ||= signal.aborted;
    } finally {
      active -= 1;
    }
  });
  const workers = Array.from({ length: MAX_OUTBOUND_PER_ORIGIN }, async () => {
    while (cursor < jobs.length && !signal.aborted) {
      const job = jobs[cursor++];
      await job();
    }
  });
  await Promise.all(workers);

  return { configured: true, attempts, succeeded, failed, maxActive, maxActivePerOrigin, durationMs: Date.now() - startedAt, aborted };
}

export async function GET(request: Request): Promise<Response> {
  if (!config.capabilityProbe.enabled) return new Response("Not found", { status: 404 });
  const suppliedToken = request.headers.get("x-capability-probe-token");
  if (!suppliedToken || !config.capabilityProbe.token || !safeEqual(suppliedToken, config.capabilityProbe.token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = Date.now();
  const statusRunId = new URL(request.url).searchParams.get("status");
  if (statusRunId !== null) {
    if (!validRunId(statusRunId)) return new Response("Invalid status id", { status: 400 });
    try {
      const record = await productionCapabilityCancellationStore().read(statusRunId);
      return Response.json(record ?? { cancelled: false, cleanupComplete: false, waitTimersCleared: 0, outboundAborted: false }, {
        headers: { "Cache-Control": "no-store", "X-Capability-State-Backend": "redis" },
        status: record ? 200 : 404,
      });
    } catch {
      return Response.json({ error: "Capability cancellation state is unavailable" }, {
        headers: { "Cache-Control": "no-store", "X-Capability-State-Backend": "redis" },
        status: 503,
      });
    }
  }

  const runId = request.headers.get("x-capability-probe-run-id");
  if (runId !== null && !validRunId(runId)) return new Response("Invalid run id", { status: 400 });
  let cancellationStore: ReturnType<typeof productionCapabilityCancellationStore> | undefined;
  if (runId) {
    try { cancellationStore = productionCapabilityCancellationStore(); }
    catch { return new Response("Capability cancellation state is unavailable", { status: 503 }); }
  }
  const startedAt = now;
  const internalAbort = new AbortController();
  let cancellationSource: CancellationEvidence["source"] | undefined;
  let waitTimersCleared = 0;
  let cleanupComplete = false;
  let outboundAborted = false;
  let recordWrites: Promise<void> = Promise.resolve();
  let finishLifetime!: () => void;
  let failLifetime!: (error: unknown) => void;
  const lifetime = new Promise<void>((resolve, reject) => { finishLifetime = resolve; failLifetime = reject; });
  if (runId) after(lifetime);
  const updateCancellationRecord = (): Promise<void> => {
    if (!runId || !cancellationSource || !cancellationStore) return recordWrites;
    const record: CancellationRecord = {
      cancelled: true,
      source: cancellationSource,
      cleanupComplete,
      waitTimersCleared,
      outboundAborted,
      updatedAt: Date.now(),
    };
    recordWrites = recordWrites.then(() => cancellationStore.write(runId, record));
    void recordWrites.catch(() => {});
    return recordWrites;
  };
  const cancel = (source: CancellationEvidence["source"]): Promise<void> => {
    if (internalAbort.signal.aborted) return lifetime;
    cancellationSource = source;
    internalAbort.abort();
    void updateCancellationRecord();
    return lifetime;
  };
  request.signal.addEventListener("abort", () => { void cancel("request"); }, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const rssSamples: number[] = [];
      const sampleRss = () => rssSamples.push(process.memoryUsage().rss);
      const send = (frame: ProbeFrame["frame"], event: ProbeFrame["event"], details: Omit<ProbeFrame, "event" | "frame" | "elapsedMs" | "rssBytes" | "memoryLimitBytes"> = {}) => {
        if (internalAbort.signal.aborted) return;
        const frameData: ProbeFrame = {
          event,
          frame,
          elapsedMs: Date.now() - startedAt,
          rssBytes: process.memoryUsage().rss,
          memoryLimitBytes: process.constrainedMemory(),
          ...details,
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(frameData)}\n`));
      };
      const native = runNativeProbe(sampleRss).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const outbound = runOutboundProbe(internalAbort.signal);
      const countClearedTimer = () => {
        waitTimersCleared += 1;
        void updateCancellationRecord();
      };

      try {
        send(0, "capability");
        await waitUntil(startedAt, 1_000, internalAbort.signal, countClearedTimer);
        if (internalAbort.signal.aborted) return;
        send(1, "capability");
        const [nativeOutcome, outboundResult] = await Promise.all([native, outbound]);
        if ("error" in nativeOutcome) throw nativeOutcome.error;
        await waitUntil(startedAt, 28_000, internalAbort.signal, countClearedTimer);
        if (internalAbort.signal.aborted) return;
        const nativeResult: NativeProbe = {
          ...nativeOutcome.value,
          peakRssBytes: Math.max(...rssSamples),
          rssSamples: rssSamples.length,
        };
        send(28, "capability", { native: nativeResult, outbound: outboundResult });
        controller.close();
      } catch (error) {
        if (!internalAbort.signal.aborted) controller.error(error);
      } finally {
        try {
          const [, outboundResult] = await Promise.all([native, outbound]);
          if (internalAbort.signal.aborted) {
            outboundAborted = outboundResult.aborted;
            cleanupComplete = true;
            await updateCancellationRecord();
          }
          finishLifetime();
        } catch (error) {
          failLifetime(error instanceof CapabilityStoreFailure ? error : new CapabilityStoreFailure());
        }
      }
    },
    cancel: () => cancel("stream"),
  });

  return new Response(stream, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
