import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createTavilySearch } from "@/server/discovery/tavily";
import { collectDiscoveryContext } from "@/server/discovery/context";
import { createLedger } from "@/server/usage/ledger";
import type { EvalScript, Ledger } from "@/server/usage/ledger";
import { createProfileServices } from "@/server/profile/services";
import { createProfileRunner, assessmentEvidence } from "@/server/profile/run-profile";
import { fixtureGrant } from "../support/profile-fixture";
import sharp from "sharp";
import { contextFixture, publisherFixture, universityFixture, decisionFixture } from "../support/fixtures";

const payload = () => ({ results: [
  { url: "https://example.edu/campus#intro", content: "  Campus   description  ", images: [
    { url: "https://example.edu/campus.jpg", description: "Courtyard" },
    { url: "javascript:evil()" }, { url: "https://example.edu/campus.jpg" }] },
  { url: "https://example.edu/campus", content: "duplicate" },
  { url: "https://user:password@example.edu/private", content: "invalid" },
  { url: "https://example.edu/about", content: "About campus" },
], images: [{ url: "https://unbound.example/photo.jpg", description: "No parent page" }], usage: { credits: 1 } });
function harness(reply: unknown = payload()) {
  const requests: RequestInit[] = [];
  const ledger = { reserve: vi.fn(async () => "reservation"), settle: vi.fn(async () => {}), check: vi.fn(async () => {}) };
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe("https://api.tavily.com/search"); requests.push(init!); return Response.json(reply);
  };
  return { ledger, requests, search: createTavilySearch({ apiKey: "synthetic-key", ledger, fetch: fetcher }) };
}
it("normalizes source-bound images and text without fabricating top-level image provenance", async () => {
  const h = harness(); const ctx = contextFixture();
  const records = await h.search({ query: "Example University", kind: "images" }, ctx);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ pageUrl: "https://example.edu/campus", imageUrl: "https://example.edu/campus.jpg",
    snippet: "Campus description", policy: { display: "link_only", retention: "transient_only" } });
  expect(records[1]).toMatchObject({ pageUrl: "https://example.edu/about" });
  expect(JSON.stringify(records)).not.toContain("unbound.example");
  expect(h.requests[0]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
  expect(JSON.parse(String(h.requests[0].body))).toMatchObject({ search_depth: "basic", include_images: true,
    include_answer: false, include_raw_content: false, auto_parameters: false, include_usage: true, safe_search: true });
  expect(h.ledger.reserve).toHaveBeenCalledWith(ctx, "tavily", 1);
  expect(h.ledger.settle).toHaveBeenCalledWith("reservation", 1);
});
it("bounds results/text and rejects a fifth dispatch even across web/image searches", async () => {
  const h = harness({ results: Array.from({ length: 20 }, (_, i) => ({ url: `https://example.edu/${i}`, content: "x".repeat(2000) })), usage: { credits: 1 } });
  const ctx = contextFixture();
  for (let i = 0; i < 4; i++) {
    const records = await h.search({ query: "test", kind: i % 2 ? "web" : "images" }, ctx);
    expect(records).toHaveLength(10); expect(records[0].snippet).toHaveLength(600);
  }
  await expect(h.search({ query: "test", kind: "web" }, ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
  expect(h.requests).toHaveLength(4);
  await h.search({ query: "test", kind: "web" }, contextFixture());
  expect(h.requests).toHaveLength(5);
});
it("accepts the live per-page string image format when image descriptions are disabled", async () => {
  const h = harness({ results: [{ url: "https://example.edu/campus", content: "Campus",
    images: ["https://example.edu/campus.jpg", "javascript:invalid", "https://example.edu/campus.jpg"] }], usage: { credits: 1 } });
  expect(await h.search({ query: "test", kind: "images" }, contextFixture())).toEqual([
    expect.objectContaining({ pageUrl: "https://example.edu/campus", imageUrl: "https://example.edu/campus.jpg" }),
  ]);
});
it("retains uncertain billing and fails closed on invalid output", async () => {
  const h = harness({ unexpected: true });
  await expect(h.search({ query: "test", kind: "web" }, contextFixture())).rejects.toMatchObject({ code: "invalid_provider_output" });
  expect(h.ledger.settle).toHaveBeenCalledWith("reservation", null);
});
it("does not refund failed dispatches or dispatch after cancellation/budget refusal", async () => {
  const h = harness();
  h.ledger.check.mockRejectedValueOnce(new Error("store down"));
  await expect(h.search({ query: "test", kind: "web" }, contextFixture())).rejects.toThrow();
  expect(h.requests).toHaveLength(0); expect(h.ledger.settle).toHaveBeenCalledWith("reservation", 0);
  h.ledger.reserve.mockRejectedValueOnce({ code: "budget_exhausted" });
  await expect(h.search({ query: "test", kind: "web" }, contextFixture())).rejects.toMatchObject({ code: "budget_exhausted" });
  const outer = new AbortController(); outer.abort();
  await expect(h.search({ query: "test", kind: "web" }, contextFixture(27000, outer.signal))).rejects.toMatchObject({ code: "cancelled" });
  expect(h.requests).toHaveLength(0);
});
it("keeps the shared discovery cutoff and uncertain billing", async () => {
  const h = harness(); const reports: unknown[] = [];
  const search = createTavilySearch({ apiKey: "synthetic", ledger: h.ledger, onLocalTimeout: r => { reports.push(r); },
    fetch: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })) });
  const ctx = { ...contextFixture(), startedAt: Date.now() - 16_950 };
  await expect(search({ query: "test", kind: "web" }, ctx)).rejects.toMatchObject({ code: "deadline" });
  expect(reports).toEqual([expect.objectContaining({ component: "provider", kind: "web_search" })]);
  expect(h.ledger.settle).toHaveBeenCalledWith("reservation", null);
});
it("joins hints only to collected parser evidence and isolates request-local data", async () => {
  const h = harness(); const collector = collectDiscoveryContext(h.search), ctx = contextFixture();
  await collector.search({ query: "test", kind: "web" }, ctx);
  const id = createHash("sha256").update("https://example.edu/campus").digest("hex");
  const evidence = [{ id, imageId: "image-one", excerpt: "Original publisher caption" }];
  expect(collector.forEvidence(evidence, ctx)).toEqual([{ evidenceId: id, imageId: "image-one", excerpt: "Campus description" }]);
  expect(collector.forEvidence([{ ...evidence[0], id: "unfetched" }], ctx)).toEqual([]);
  expect(collector.forEvidence(evidence, contextFixture())).toEqual([]);
});
it("accounts Tavily with a separate aggregate allowance and a four-credit request cap", async () => {
  const evaluate = vi.fn<EvalScript>(async () => 1);
  const ledger = createLedger(evaluate, { tavilyAllowanceCredits: 20 });
  await ledger.reserve(contextFixture(), "tavily", 1);
  expect(evaluate.mock.calls[0][1][1]).toContain("used:tavily:all");
  expect(evaluate.mock.calls[0][2].slice(0, 4)).toEqual(["reserve", "1", "20", "4"]);
  const zero = vi.fn<EvalScript>(async () => 0);
  await expect(createLedger(zero).reserve(contextFixture(), "tavily", 1)).rejects.toMatchObject({ code: "budget_exhausted" });
  expect(zero.mock.calls[0][2][2]).toBe("0");
});
it("includes independently fetched corroboration text once without inventing evidence", () => {
  const { evidence } = decisionFixture({ authority: "attributable", association: "explicit", corroboration: 20, visual: 10 });
  const rows = assessmentEvidence([evidence, evidence]);
  expect(rows.map(row => row.id)).toEqual(["attribution-source", "independent-source"]);
  expect(rows[1].excerpt).toContain("Independent reporting");
  expect(rows.every(row => row.imageId === evidence.imageId)).toBe(true);
});
it("connects Tavily, publisher parsing, image preparation and OpenAI with separate source-bound hints", async () => {
  const reservations: string[] = [], stages: unknown[] = [], aiPayloads: Record<string, unknown>[] = [];
  const ledger: Ledger = { admit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    reserve: async (_ctx, kind) => { reservations.push(kind); return "synthetic-reservation"; },
    settle: async () => {}, check: async () => {}, renew: async () => {}, release: async () => {} };
  const raster = await sharp({ create: { width: 640, height: 480, channels: 3, background: "navy" } }).png().toBuffer();
  const university = { ...universityFixture(), campus: "Example City" };
  const services = createProfileServices({ ledger, apiKey: "synthetic-openai", model: "gpt-5.6-luna", braveKey: "",
    searchProvider: "tavily", tavilyKey: "synthetic-tavily", policies: new Map([[fixtureGrant.origin, fixtureGrant]]),
    providerFetch: async url => {
      expect(String(url)).toBe("https://api.tavily.com/search");
      return Response.json({ results: [{ url: "https://example.edu/campus", content: "Search provider campus hint" }], usage: { credits: 1 } });
    }, fetcher: async (url, kind) => kind === "image"
      ? { finalUrl: url, status: 200, bytes: raster, contentType: "image/png", retrievedAt: new Date().toISOString() }
      : { ...publisherFixture(url.endsWith("/campus")
        ? '<figure><img src="/campus.png"><figcaption>Example University, Example City campus courtyard.</figcaption></figure>' : "<h1>Example University</h1>"), finalUrl: url } });
  services.resolve = async () => ({ kind: "resolved", university });
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); const content = JSON.parse(request.input[0].content[0].text);
    aiPayloads.push(content); const evidence = content.untrustedPublisherEvidence[0];
    return Response.json({ id: "resp_fixture", object: "response", created_at: 1789574400, model: "gpt-5.6-luna", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ assessments: [{ imageId: evidence.imageId,
        assessed: true, category: "campus", visual: 10, safety: "clear", relevance: "relevant", authenticity: "photo", location: "supported",
        evidenceIds: [evidence.id], observations: ["Courtyard"], uncertainties: [] }] }) }] }], usage: { input_tokens: 1000, output_tokens: 100 } });
  });
  try {
    await createProfileRunner(services)({ query: university.name, countryHint: "" }, contextFixture(), event => { stages.push(event); });
    expect(reservations).toEqual(["tavily", "ai"]);
    expect(aiPayloads).toHaveLength(1);
    expect(aiPayloads[0].untrustedDiscoveryContext).toEqual([expect.objectContaining({ excerpt: "Search provider campus hint" })]);
    expect(aiPayloads[0].untrustedPublisherEvidence).toEqual([expect.objectContaining({ excerpt: expect.stringContaining("campus courtyard") })]);
    expect(stages).toContainEqual(expect.objectContaining({ type: "image", data: expect.objectContaining({ card: expect.objectContaining({ status: "verified" }) }) }));
  } finally { vi.unstubAllGlobals(); }
});
