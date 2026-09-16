type ProbeFrame = { frame: number; elapsedMs: number; rssBytes: number; memoryLimitBytes: number; native?: { sourcePixels: number; decodes: number } };

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readFrames(url: string, token: string, signal?: AbortSignal, stopAfterFirst = false): Promise<ProbeFrame[]> {
  const response = await fetch(`${url.replace(/\/$/, "")}/api/capability`, {
    headers: { "x-capability-probe-token": token },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Probe request failed with HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: ProbeFrame[] = [];
  let pending = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line) frames.push(JSON.parse(line) as ProbeFrame);
      if (stopAfterFirst && frames.length) {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

async function main() {
  const url = option("--url") ?? process.env.DEPLOYMENT_URL;
  const token = process.env.CAPABILITY_PROBE_TOKEN;
  if (!url || !token) throw new Error("DEPLOYMENT_URL/--url and CAPABILITY_PROBE_TOKEN are required");

  const cancellation = new AbortController();
  const firstFrame = await readFrames(url, token, cancellation.signal, true);
  cancellation.abort();
  const runs = await Promise.all(Array.from({ length: 3 }, () => readFrames(url, token)));
  const frames = runs.flat();
  const peakRssBytes = Math.max(...frames.map((frame) => frame.rssBytes));
  const memoryLimitBytes = Math.max(...frames.map((frame) => frame.memoryLimitBytes));
  const headroom = memoryLimitBytes > 0 ? 1 - peakRssBytes / memoryLimitBytes : null;
  const completed = runs.every((run) => run.some((frame) => frame.frame === 28));
  const native = frames.find((frame) => frame.native)?.native;

  if (!firstFrame.some((frame) => frame.frame === 0) || !completed || !native || native.sourcePixels !== 20_000_000 || native.decodes > 2) {
    throw new Error("Probe did not provide the required streamed image-processing evidence");
  }
  if (headroom !== null && headroom < 0.25) throw new Error(`Memory headroom below 25%: ${headroom}`);

  console.log(JSON.stringify({
    cancellationFirstFrame: firstFrame[0]?.frame,
    completedThreeConcurrentRuns: completed,
    peakRssBytes,
    memoryLimitBytes,
    memoryHeadroom: headroom,
    sourcePixels: native.sourcePixels,
    decodesPerRequest: native.decodes,
  }));
}

void main();
