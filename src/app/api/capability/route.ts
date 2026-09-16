import { createHash, timingSafeEqual } from "node:crypto";
import process from "node:process";

import sharp from "sharp";

import { config } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE_WIDTH = 5_000;
const SOURCE_HEIGHT = 4_000;
const SOURCE_PIXELS = SOURCE_WIDTH * SOURCE_HEIGHT;
const FRAME_AT_MS = [0, 1_000, 28_000] as const;
const MAX_OUTBOUND_REQUESTS = 6;
const MAX_OUTBOUND_PER_ORIGIN = 2;
const encoder = new TextEncoder();

type ProbeFrame = {
  event: "capability";
  frame: number;
  elapsedMs: number;
  rssBytes: number;
  memoryLimitBytes: number;
  native?: { hash: string; durationMs: number; decodes: number; sourcePixels: number };
  outbound?: { configured: boolean; attempts: number; succeeded: number; durationMs: number };
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function waitUntil(startedAt: number, targetMs: number, signal: AbortSignal): Promise<void> {
  const remaining = Math.max(0, targetMs - (Date.now() - startedAt));
  if (signal.aborted || remaining === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, remaining);
    const onAbort = () => cleanup();
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runNativeProbe(): Promise<NonNullable<ProbeFrame["native"]>> {
  const startedAt = Date.now();
  const raster = await sharp({
    create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: "#2450a4" },
  }).png().toBuffer();
  const decoded = await Promise.all(
    Array.from({ length: 2 }, () => sharp(raster).resize({ width: 1_600 }).raw().toBuffer()),
  );
  const hash = createHash("sha256").update(decoded[0]).digest("hex");

  return { hash, durationMs: Date.now() - startedAt, decodes: decoded.length, sourcePixels: SOURCE_PIXELS };
}

async function runOutboundProbe(requestSignal: AbortSignal): Promise<NonNullable<ProbeFrame["outbound"]>> {
  const endpoint = config.capabilityProbe.endpoint;
  if (!endpoint) return { configured: false, attempts: 0, succeeded: 0, durationMs: 0 };

  const startedAt = Date.now();
  let cursor = 0;
  let succeeded = 0;
  const jobs = Array.from({ length: MAX_OUTBOUND_REQUESTS }, () => async () => {
    const response = await fetch(endpoint, {
      method: "HEAD",
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5_000)]),
    });
    if (response.ok) succeeded += 1;
  });
  const workers = Array.from({ length: MAX_OUTBOUND_PER_ORIGIN }, async () => {
    while (cursor < jobs.length && !requestSignal.aborted) {
      const job = jobs[cursor++];
      try {
        await job();
      } catch {
        // Probe reports aggregate timing and counts only.
      }
    }
  });
  await Promise.all(workers);

  return { configured: true, attempts: MAX_OUTBOUND_REQUESTS, succeeded, durationMs: Date.now() - startedAt };
}

export async function GET(request: Request): Promise<Response> {
  if (!config.capabilityProbe.enabled) return new Response("Not found", { status: 404 });
  const suppliedToken = request.headers.get("x-capability-probe-token");
  if (!suppliedToken || !config.capabilityProbe.token || !safeEqual(suppliedToken, config.capabilityProbe.token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: number, details: Omit<ProbeFrame, "event" | "frame" | "elapsedMs" | "rssBytes" | "memoryLimitBytes"> = {}) => {
        if (cancelled || request.signal.aborted) return;
        const frameData: ProbeFrame = {
          event: "capability",
          frame,
          elapsedMs: Date.now() - startedAt,
          rssBytes: process.memoryUsage().rss,
          memoryLimitBytes: process.constrainedMemory(),
          ...details,
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(frameData)}\n`));
      };
      const native = runNativeProbe();
      const outbound = runOutboundProbe(request.signal);

      try {
        send(0);
        await waitUntil(startedAt, FRAME_AT_MS[1], request.signal);
        send(1);
        const [nativeResult, outboundResult] = await Promise.all([native, outbound]);
        await waitUntil(startedAt, FRAME_AT_MS[2], request.signal);
        send(28, { native: nativeResult, outbound: outboundResult });
        if (!cancelled && !request.signal.aborted) controller.close();
      } catch (error) {
        if (!cancelled && !request.signal.aborted) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
  return new Response(stream, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
