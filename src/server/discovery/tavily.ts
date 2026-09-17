import { z } from "zod";
import type { RunContext, UsagePolicy } from "@/server/contracts";
import type { Ledger } from "@/server/usage/ledger";
import { assertActive, DiscoveryFailure, httpUrl, providerJson } from "./http";
import type { DiscoveryRecord, Search } from "./search";
import type { LocalTimeoutSink } from "./timeout-diagnostics";

const schema = z.object({ results: z.array(z.object({ url: z.string().max(4096), content: z.string().max(100_000).nullish(),
  images: z.array(z.union([z.string().max(4096), z.object({ url: z.string().max(4096) })])).max(100).optional() })).max(20),
  usage: z.object({ credits: z.number().int().nonnegative().max(100) }).optional() });
const policy: UsagePolicy = { origin: "https://api.tavily.com", policyVersion: "2026-09-17",
  retention: "transient_only", display: "link_only",
  basis: ["Tavily Search discovery only; original publisher access, attribution and license verification required"] };
const canonical = (value: string) => {
  if (!httpUrl(value)) return;
  const url = new URL(value); url.hash = ""; return url.href;
};

export function createTavilySearch(dependencies: { apiKey: string; ledger: Pick<Ledger, "reserve" | "settle" | "check">;
  fetch?: typeof fetch; onLocalTimeout?: LocalTimeoutSink }): Search {
  const attempts = new WeakMap<RunContext, number>();
  return async (input, ctx) => {
    assertActive(ctx);
    if (!dependencies.apiKey) throw new DiscoveryFailure("dependency_unavailable");
    if (!input.query.trim() || input.query.length > 400) throw new DiscoveryFailure("invalid_request");
    const count = attempts.get(ctx) ?? 0;
    if (count >= 4) throw new DiscoveryFailure("budget_exhausted");
    attempts.set(ctx, count + 1);
    const reservation = await dependencies.ledger.reserve(ctx, "tavily", 1);
    let dispatched = false;
    try {
      await dependencies.ledger.check(ctx); assertActive(ctx);
      dispatched = true;
      const payload = await providerJson(dependencies.fetch ?? fetch, new URL("https://api.tavily.com/search"), ctx,
        { Authorization: `Bearer ${dependencies.apiKey}`, "content-type": "application/json" },
        { kind: input.kind === "web" ? "web_search" : "image_search", sink: dependencies.onLocalTimeout },
        JSON.stringify({ query: input.query, search_depth: "basic", max_results: 10, topic: "general", safe_search: true,
          include_images: input.kind === "images", include_image_descriptions: false,
          include_answer: false, include_raw_content: false, auto_parameters: false, include_usage: true }));
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new DiscoveryFailure("invalid_provider_output");
      // Known unexpected usage is still charged; never hide under-reservation.
      await dependencies.ledger.settle(reservation, parsed.data.usage?.credits ?? 1);
      if (parsed.data.usage && parsed.data.usage.credits !== 1) throw new DiscoveryFailure("invalid_provider_output");
      assertActive(ctx);
      const records: DiscoveryRecord[] = [], seen = new Set<string>();
      for (const result of parsed.data.results) {
        const pageUrl = canonical(result.url);
        if (!pageUrl || seen.has(pageUrl)) continue;
        seen.add(pageUrl);
        const snippet = result.content?.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 600) || undefined;
        // Only per-result images establish a source-page binding. Unbound top-level
        // images cannot be assigned by rank, title similarity or guessed file paths.
        const images = input.kind === "images" ? [...new Set((result.images ?? []).map(image => canonical(typeof image === "string" ? image : image.url)).filter(Boolean))].slice(0, 2) : [];
        for (const imageUrl of images.length ? images : [undefined]) {
          records.push({ pageUrl, ...(imageUrl ? { imageUrl } : {}), ...(snippet ? { snippet } : {}), policy: { ...policy, basis: [...policy.basis] } });
          if (records.length === 10) return records;
        }
      }
      return records;
    } catch (error) {
      await dependencies.ledger.settle(reservation, dispatched ? null : 0).catch(() => {});
      throw error;
    }
  };
}
