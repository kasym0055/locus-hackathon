import type { FailureCode, RunContext } from "@/server/contracts";

export class DiscoveryFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "DiscoveryFailure"; }
}
export function assertActive(ctx: RunContext) {
  if (ctx.signal.aborted) throw new DiscoveryFailure("cancelled");
  if (Date.now() >= ctx.deadlineAt) throw new DiscoveryFailure("deadline");
}

// Fixed provider endpoints only. Publisher URLs always use the separate safe fetcher.
export async function providerJson(fetcher: typeof fetch, url: URL, ctx: RunContext, headers: Record<string, string> = {}): Promise<unknown> {
  assertActive(ctx);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.min(3_000, ctx.deadlineAt - Date.now())))]);
  try {
    const response = await fetcher(url, { headers: { accept: "application/json", ...headers }, signal, redirect: "error", cache: "no-store" });
    if (!response.ok) { await response.body?.cancel(); throw new DiscoveryFailure("dependency_unavailable"); }
    if (!response.headers.get("content-type")?.includes("application/json") || !response.body) {
      await response.body?.cancel(); throw new DiscoveryFailure("invalid_provider_output");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) throw new DiscoveryFailure("invalid_provider_output");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DiscoveryFailure("invalid_provider_output"); }
  } catch (error) {
    if (ctx.signal.aborted) throw new DiscoveryFailure("cancelled");
    if (signal.aborted) throw new DiscoveryFailure("deadline");
    if (error instanceof DiscoveryFailure) throw error;
    throw new DiscoveryFailure("dependency_unavailable");
  }
}

export function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && (!url.port || ["80", "443"].includes(url.port));
  } catch { return false; }
}
