import { describe, expect, it, vi } from "vitest";
import { createBraveSearch } from "@/server/discovery/brave";
import { createSafeFetcher } from "@/server/fetch/safe-fetch";
import { contextFixture } from "../support/fixtures";
import { reportLocalTimeout } from "@/server/discovery/timeout-diagnostics";

const waitForAbort: typeof fetch = async (_, init) => new Promise((_, reject) => {
  const signal = init!.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const ledger = { reserve: async () => "reservation", check: async () => {}, settle: async () => {} };
const nearDiscoveryCutoff = () => {
  const now = Date.now();
  return { ...contextFixture(), startedAt: now - 16_950, deadlineAt: now + 10_000 };
};

describe("local discovery timeout diagnostics", () => {
  it("bounds the default server log to one event per component and resets for each request", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = contextFixture(), local = new AbortController();
      const signal = AbortSignal.any([ctx.signal, local.signal]);
      local.abort(new DOMException("Local timer", "TimeoutError"));
      for (let index = 0; index < 20; index++) {
        reportLocalTimeout(ctx, local.signal, signal, 3_000, { component: "provider", kind: "web_search" });
        reportLocalTimeout(ctx, local.signal, signal, 3_000, { component: "publisher", kind: "robots", phase: "identity" });
      }
      const reports = log.mock.calls.map(([line]) => JSON.parse(line));
      expect(reports).toEqual([
        { event: "discovery_local_timeout", requestId: ctx.requestId, component: "provider", kind: "web_search", elapsedMs: expect.any(Number) },
        { event: "discovery_local_timeout", requestId: ctx.requestId, component: "publisher", kind: "robots", phase: "identity", elapsedMs: expect.any(Number) },
      ]);
      reportLocalTimeout(contextFixture(), local.signal, signal, 3_000, { component: "provider", kind: "image_search" });
      expect(log.mock.calls).toHaveLength(3);
    } finally { log.mockRestore(); }
  });
  it("does not label a competing cancellation or elapsed outer deadline as local", () => {
    const reports: unknown[] = [], outer = new AbortController(), local = new AbortController();
    const ctx = contextFixture(27_000, outer.signal), signal = AbortSignal.any([outer.signal, local.signal]);
    outer.abort(new Error("client")); local.abort(new DOMException("timer", "TimeoutError"));
    reportLocalTimeout(contextFixture(), local.signal, signal, 3_000, { component: "provider", kind: "web_search" }, report => { reports.push(report); });
    reportLocalTimeout({ ...ctx, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }, local.signal, local.signal,
      3_000, { component: "publisher", kind: "image", phase: "image_preparation" }, report => { reports.push(report); });
    expect(reports).toEqual([]);
  });
  it.each(["web", "images"] as const)("reports provider %s local timeout with no request content", async kind => {
    const reports: unknown[] = [];
    const ctx = nearDiscoveryCutoff();
    const search = createBraveSearch({ apiKey: "private-key", ledger, fetch: waitForAbort,
      onLocalTimeout: report => { reports.push(report); throw new Error("sink unavailable"); } });
    await expect(search({ query: "private-query", kind }, ctx)).rejects.toMatchObject({ code: "deadline" });
    expect(reports).toEqual([{ event: "discovery_local_timeout", requestId: ctx.requestId, component: "provider",
      kind: kind === "web" ? "web_search" : "image_search", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(reports)).not.toMatch(/private|https?:|headers|body|phase/);
  });
  it("reports publisher local timeout without changing failure when the sink rejects", async () => {
    const reports: unknown[] = [];
    const client = createSafeFetcher({ contactUrl: "https://project.org/contact", resolve: async () => new Promise(() => {}),
      onLocalTimeout: report => { reports.push(report); return Promise.reject(new Error("sink unavailable")); } });
    const ctx = { ...nearDiscoveryCutoff(), publisherPhase: "licensed_file" as const };
    await expect(client.safeFetch("https://private-publisher.org/path?private-query", "html", ctx)).rejects.toMatchObject({ code: "deadline" });
    expect(reports).toEqual([{ event: "discovery_local_timeout", requestId: ctx.requestId, component: "publisher",
      phase: "licensed_file", kind: "html", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(reports)).not.toMatch(/private|https?:|headers|body/);
  });
  it("reports a local timeout returned by the direct robots/access check", async () => {
    const reports: unknown[] = [];
    const client = createSafeFetcher({ contactUrl: "https://project.org/contact", resolve: async () => new Promise(() => {}),
      onLocalTimeout: report => { reports.push(report); } });
    const ctx = { ...nearDiscoveryCutoff(), publisherPhase: "official_corroboration" as const };
    expect(await client.checkAccess("https://publisher.org/page", ctx)).toMatchObject({ allowed: false, reason: "deadline" });
    expect(reports).toEqual([{ event: "discovery_local_timeout", requestId: ctx.requestId, component: "publisher",
      phase: "official_corroboration", kind: "robots", elapsedMs: expect.any(Number) }]);
  });
  it("allows a provider response beyond three seconds while the shared discovery window remains", async () => {
    const reports: unknown[] = [];
    const search = createBraveSearch({ apiKey: "key", ledger, onLocalTimeout: report => { reports.push(report); },
      fetch: async (_, init) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ type: "search", web: { results: [] } })), 3_100);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      }) });

    await expect(search({ query: "query", kind: "web" }, contextFixture())).resolves.toEqual([]);
    expect(reports).toEqual([]);
  });
  it.each(["deadline", "cancel", "outer-timeout"] as const)("does not report local timeouts for outer %s", async mode => {
    const reports: unknown[] = [];
    const controller = new AbortController();
    const ctx = contextFixture(mode === "deadline" ? 80 : 27_000, controller.signal);
    const search = createBraveSearch({ apiKey: "key", ledger, fetch: waitForAbort, onLocalTimeout: report => { reports.push(report); } });
    const client = createSafeFetcher({ contactUrl: "https://project.org/contact", resolve: async () => new Promise(() => {}),
      onLocalTimeout: report => { reports.push(report); } });
    const timer = mode === "deadline" ? undefined : setTimeout(() => controller.abort(mode === "outer-timeout"
      ? new DOMException("Outer deadline", "TimeoutError") : new Error("Client cancelled")), 20);
    try {
      const results = await Promise.allSettled([search({ query: "query", kind: "web" }, ctx),
        client.safeFetch("https://publisher.org/page", "html", ctx)]);
      expect(results).toMatchObject([
        { status: "rejected", reason: { code: mode === "deadline" ? "deadline" : "cancelled" } },
        { status: "rejected", reason: { code: mode === "cancel" ? "cancelled" : "deadline" } },
      ]);
      expect(reports).toEqual([]);
    } finally { clearTimeout(timer); }
  });
  it("does not report ordinary provider/publisher failures or admission budget failures", async () => {
    const reports: unknown[] = [];
    const onLocalTimeout = (report: unknown) => { reports.push(report); };
    const ctx = contextFixture();
    const search = createBraveSearch({ apiKey: "key", ledger, fetch: async () => { throw new Error("network"); }, onLocalTimeout });
    await expect(search({ query: "query", kind: "web" }, ctx)).rejects.toMatchObject({ code: "dependency_unavailable" });
    const blocked = createBraveSearch({ apiKey: "key", ledger: { ...ledger, reserve: async () => { throw { code: "budget_exhausted" }; } }, onLocalTimeout });
    await expect(blocked({ query: "query", kind: "web" }, ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    const denied = createSafeFetcher({ onLocalTimeout });
    await expect(denied.safeFetch("https://publisher.org/page", "html", ctx)).rejects.toMatchObject({ code: "access_denied" });
    const unavailable = createSafeFetcher({ contactUrl: "https://project.org/contact", resolve: async () => { throw new Error("DNS unavailable"); }, onLocalTimeout });
    await expect(unavailable.safeFetch("https://publisher.org/page", "robots", ctx)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(reports).toEqual([]);
  });
});
