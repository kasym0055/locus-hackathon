import { z } from "zod";
import type { RunContext, UsagePolicy } from "@/server/contracts";
import type { Ledger } from "@/server/usage/ledger";
import { assertActive, DiscoveryFailure, httpUrl, providerJson } from "./http";
import type { LocalTimeoutSink } from "./timeout-diagnostics";

export interface SearchInput { query: string; kind: "web" | "images" }
export interface DiscoveryRecord { pageUrl: string; imageUrl?: string; policy: UsagePolicy }
export type Search = (input: SearchInput, ctx: RunContext) => Promise<DiscoveryRecord[]>;
const url = z.string().refine(httpUrl);
const webSchema = z.object({ type: z.literal("search"), web: z.object({ results: z.array(z.object({ url, is_offensive: z.boolean().optional() })).max(100) }).optional() });
const imageSchema = z.object({ type: z.literal("images"), results: z.array(z.object({ url: url.nullable(), properties: z.object({ url: url.nullable() }).nullable(), is_offensive: z.boolean().optional() })).max(200) });
const policy: UsagePolicy = { origin: "https://api.search.brave.com", policyVersion: "v1",
  retention: "transient_only", display: "link_only", basis: ["Brave Search discovery; transient operational processing only; publisher verification required"] };

export function createBraveSearch(dependencies: { apiKey: string; ledger: Pick<Ledger, "reserve" | "settle" | "check">; fetch?: typeof fetch;
  onLocalTimeout?: LocalTimeoutSink }): Search {
  const attempts = new WeakMap<RunContext, number>();
  return async (input, ctx) => {
    assertActive(ctx);
    if (!dependencies.apiKey) throw new DiscoveryFailure("dependency_unavailable");
    if (!input.query.trim() || input.query.length > 400) throw new DiscoveryFailure("invalid_request");
    const count = attempts.get(ctx) ?? 0;
    if (count >= 10) throw new DiscoveryFailure("budget_exhausted");
    attempts.set(ctx, count + 1);
    const parameters = new URLSearchParams({ q: input.query, safesearch: "strict", count: "10" });
    const endpoint = input.kind === "images" ? "https://api.search.brave.com/res/v1/images/search" : "https://api.search.brave.com/res/v1/web/search";
    const reservation = await dependencies.ledger.reserve(ctx, "brave", 1);
    let dispatched = false;
    try {
      await dependencies.ledger.check(ctx);
      assertActive(ctx);
      dispatched = true;
      const payload = await providerJson(dependencies.fetch ?? fetch, new URL(`${endpoint}?${parameters}`), ctx,
        { "x-subscription-token": dependencies.apiKey },
        { kind: input.kind === "web" ? "web_search" : "image_search", sink: dependencies.onLocalTimeout });
      await dependencies.ledger.settle(reservation, 1);
      if (input.kind === "web") {
        const parsed = webSchema.safeParse(payload);
        if (!parsed.success || (payload && typeof payload === "object" && "error" in payload)) throw new DiscoveryFailure("invalid_provider_output");
        return (parsed.data.web?.results ?? []).filter((item) => !item.is_offensive).slice(0, 10).map((item) => ({ pageUrl: item.url, policy: { ...policy } }));
      }
      const parsed = imageSchema.safeParse(payload);
      if (!parsed.success) throw new DiscoveryFailure("invalid_provider_output");
      return parsed.data.results.filter((item) => item.url && item.properties?.url && !item.is_offensive).slice(0, 10)
        .map((item) => ({ pageUrl: item.url!, imageUrl: item.properties!.url!, policy: { ...policy } }));
    } catch (error) {
      // Unknown provider billing stays reserved; a store failure cannot refund it.
      await dependencies.ledger.settle(reservation, dispatched ? null : 0).catch(() => {});
      throw error;
    }
  };
}

let productionSearch: Search | undefined;
export async function searchBrave(input: SearchInput, ctx: RunContext): Promise<DiscoveryRecord[]> {
  if (!productionSearch) {
    const [{ config }, { productionLedger }] = await Promise.all([import("@/server/config"), import("@/server/usage/ledger")]);
    productionSearch = createBraveSearch({ apiKey: config.brave.apiKey, ledger: await productionLedger() });
  }
  return productionSearch(input, ctx);
}
