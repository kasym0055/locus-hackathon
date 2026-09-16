import { randomUUID } from "node:crypto";

import { assessProbe, type ProbeCapture, type ProbeFrameCapture } from "@/server/probe-contract";

type ServerFrame = Omit<ProbeFrameCapture, "arrivalMs" | "serverElapsedMs"> & {
  elapsedMs: number;
  event: "capability";
};
type CancellationEvidence = ProbeCapture["cancellation"];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readFrames(url: string, token: string, runId?: string, stopAfterFirst = false): Promise<ProbeFrameCapture[]> {
  const startedAt = performance.now();
  const response = await fetch(`${url.replace(/\/$/, "")}/api/capability`, {
    headers: {
      "x-capability-probe-token": token,
      ...(runId ? { "x-capability-probe-run-id": runId } : {}),
    },
  });
  if (!response.ok || !response.body) throw new Error(`Probe request failed with HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: ProbeFrameCapture[] = [];
  let pending = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const frame = JSON.parse(line) as ServerFrame;
      frames.push({
        frame: frame.frame,
        arrivalMs: Math.round(performance.now() - startedAt),
        serverElapsedMs: frame.elapsedMs,
        rssBytes: frame.rssBytes,
        memoryLimitBytes: frame.memoryLimitBytes,
        native: frame.native,
        outbound: frame.outbound,
      });
      if (stopAfterFirst) {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

async function readCancellationEvidence(url: string, token: string, runId: string): Promise<CancellationEvidence> {
  const endpoint = `${url.replace(/\/$/, "")}/api/capability?status=${encodeURIComponent(runId)}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(endpoint, { headers: { "x-capability-probe-token": token } });
    if (response.ok) {
      const evidence = await response.json() as CancellationEvidence;
      if (evidence.cleanupComplete) return evidence;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Probe did not provide server-side cancellation cleanup evidence");
}

async function main() {
  const url = option("--url") ?? process.env.DEPLOYMENT_URL;
  const token = process.env.CAPABILITY_PROBE_TOKEN;
  const allowUnknownMemory = process.argv.includes("--allow-unknown-memory");
  if (!url || !token) throw new Error("DEPLOYMENT_URL/--url and CAPABILITY_PROBE_TOKEN are required");

  const cancellationRunId = randomUUID();
  const clientCancellation = await readFrames(url, token, cancellationRunId, true);
  const cancellationEvidence = await readCancellationEvidence(url, token, cancellationRunId);
  const runs = await Promise.all(Array.from({ length: 3 }, () => readFrames(url, token)));
  const assessment = assessProbe({
    runs,
    cancellation: {
      cancelled: cancellationEvidence.cancelled,
      source: cancellationEvidence.source,
      cleanupComplete: cancellationEvidence.cleanupComplete,
      waitTimersCleared: cancellationEvidence.waitTimersCleared,
      outboundAborted: cancellationEvidence.outboundAborted,
    },
  }, { allowUnknownMemory });

  console.log(JSON.stringify({
    status: assessment.status,
    clientCancellationFirstArrivalMs: clientCancellation[0]?.arrivalMs,
    serverCancellation: cancellationEvidence,
    peakRssBytes: assessment.peakRssBytes,
    instances: assessment.instances,
    firstArrivalsMs: runs.map((run) => run.find((frame) => frame.frame === 0)?.arrivalMs),
    finalArrivalsMs: runs.map((run) => run.find((frame) => frame.frame === 28)?.arrivalMs),
  }));
}

void main();
