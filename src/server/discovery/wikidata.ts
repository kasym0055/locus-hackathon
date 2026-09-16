import { z } from "zod";
import type { RunContext, UsagePolicy } from "@/server/contracts";
import { assertActive, DiscoveryFailure, httpUrl, providerJson } from "./http";

export interface WikidataIdentity { entityId: string; name: string; aliases: string[]; website?: string; city?: string; country?: string }
export type Lookup = (query: string, ctx: RunContext) => Promise<WikidataIdentity[]>;
export const wikidataPolicy: UsagePolicy = { origin: "https://www.wikidata.org", policyVersion: "v1", retention: "cache_permitted", display: "link_only", basis: ["Wikidata structured data CC0"] };
const text = z.object({ value: z.string() });
const searchSchema = z.object({ success: z.literal(1), search: z.array(z.object({ id: z.string().regex(/^Q\d+$/) })).max(5) });
const entitySchema = z.object({ id: z.string(), labels: z.record(z.string(), text).default({}), aliases: z.record(z.string(), z.array(text)).default({}),
  descriptions: z.record(z.string(), text).default({}), claims: z.record(z.string(), z.array(z.object({ rank: z.string().optional(), mainsnak: z.object({ snaktype: z.string(), datavalue: z.object({ value: z.unknown() }).optional() }) }))).default({}) });
const entitiesSchema = z.object({ success: z.literal(1), entities: z.record(z.string(), entitySchema) });

export function createWikidataLookup(dependencies: { fetch?: typeof fetch } = {}): Lookup {
  const counts = new WeakMap<RunContext, number>();
  async function request(parameters: Record<string, string>, ctx: RunContext) {
    assertActive(ctx);
    const count = counts.get(ctx) ?? 0;
    if (count >= 2) throw new DiscoveryFailure("budget_exhausted");
    counts.set(ctx, count + 1);
    return providerJson(dependencies.fetch ?? fetch, new URL(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: "json", ...parameters })}`), ctx,
      { "user-agent": "VisualUniversityProfile/0.1 (bounded Wikidata identity lookup)" });
  }
  return async (query, ctx) => {
    if (!query.trim() || query.length > 160) throw new DiscoveryFailure("invalid_request");
    const found = searchSchema.safeParse(await request({ action: "wbsearchentities", search: query, language: "en", uselang: "en", type: "item", limit: "5" }, ctx));
    if (!found.success) throw new DiscoveryFailure("invalid_provider_output");
    if (!found.data.search.length) return [];
    const ids = [...new Set(found.data.search.map((item) => item.id))];
    const fetched = entitiesSchema.safeParse(await request({ action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|descriptions|claims", languages: "en|ru|kk" }, ctx));
    if (!fetched.success) throw new DiscoveryFailure("invalid_provider_output");
    return ids.flatMap((id) => {
      const entity = fetched.data.entities[id];
      const name = entity?.labels.en?.value ?? entity?.labels.ru?.value ?? entity?.labels.kk?.value;
      if (!entity || !name || entity.id !== id) return [];
      const websites = (entity.claims.P856 ?? []).filter((claim) => claim.rank !== "deprecated" && claim.mainsnak.snaktype === "value")
        .map((claim) => claim.mainsnak.datavalue?.value).filter((value): value is string => typeof value === "string" && httpUrl(value));
      // Only an explicit descriptive location is exposed; entity IDs never become invented place names.
      // Missing/other description forms remain unresolved within the two-request bound.
      const location = /^(?:public |private |research |technical |national )*(?:university|institute of technology) in ([^,;]+), ([^,;]+)$/iu.exec(entity.descriptions.en?.value ?? "");
      return [{ entityId: id, name, aliases: [...new Set(Object.values(entity.aliases).flatMap((items) => items.map((item) => item.value)))],
        ...(websites.length === 1 ? { website: websites[0] } : {}), ...(location ? { city: location[1].trim(), country: location[2].trim() } : {}) }];
    });
  };
}
export const lookupWikidata = createWikidataLookup();
