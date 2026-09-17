import type { RunContext } from "@/server/contracts";

type TimeoutDetails = { component: "provider"; kind: "web_search" | "image_search" }
  | { component: "publisher"; kind: "html" | "image" | "robots"; phase: NonNullable<RunContext["publisherPhase"]> | "unspecified" };
export type LocalTimeoutReport = TimeoutDetails & { event: "discovery_local_timeout"; requestId: string; elapsedMs: number };
export type LocalTimeoutSink = (report: LocalTimeoutReport) => void | Promise<void>;
const reported = new WeakMap<RunContext, Set<TimeoutDetails["component"]>>();

// Observe only the request-local discovery window winning the composite
// signal. The outer request deadline and client cancellation remain distinct.
export function reportLocalTimeout(ctx: RunContext, local: AbortSignal, combined: AbortSignal, duration: number,
  details: TimeoutDetails, sink: LocalTimeoutSink = report => console.warn(JSON.stringify(report))) {
  try {
    if (duration <= 0 || !local.aborted || combined.reason !== local.reason
      || ctx.signal.aborted || Date.now() >= ctx.deadlineAt) return;
    let components = reported.get(ctx);
    if (!components) { components = new Set(); reported.set(ctx, components); }
    if (components.has(details.component)) return;
    components.add(details.component); // At most one event per component per request, even if the sink fails.
    const report: LocalTimeoutReport = { event: "discovery_local_timeout", requestId: ctx.requestId,
      ...details, elapsedMs: Math.max(0, Date.now() - ctx.startedAt) };
    void Promise.resolve(sink(report)).catch(() => {});
  } catch { /* Diagnostics must not change transport failures or cleanup. */ }
}
