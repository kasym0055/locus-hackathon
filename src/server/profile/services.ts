import type { Ledger } from "@/server/usage/ledger";
import { productionLedger } from "@/server/usage/ledger";
import { createResolver } from "@/server/discovery/resolver";
import { createDiscoveryPlanner } from "@/server/discovery/planner";
import { createWikidataLookup } from "@/server/discovery/wikidata";
import { createBraveSearch } from "@/server/discovery/brave";
import { safeFetch } from "@/server/fetch/safe-fetch";
import { createImagePreparer } from "@/server/images/prepare";
import { createOpenAiAdapter } from "@/server/ai/openai";
import type { UsagePolicy } from "@/server/contracts";
import { policySchema } from "@/lib/event-schema";
import { z } from "zod";

// Operator-owned documentation only. No query or request can supply grants.
export function readPublisherPolicies(raw: string | undefined): ReadonlyMap<string, UsagePolicy> {
  if (!raw) return new Map();
  if (Buffer.byteLength(raw) > 16_384) throw new Error("dependency_unavailable");
  const policies = z.array(policySchema.extend({ origin: z.url(), basis: z.array(z.string().trim().min(1).max(2000)).min(1).max(5) })).max(16).parse(JSON.parse(raw));
  const result = new Map<string, UsagePolicy>();
  for (const policy of policies) {
    const url = new URL(policy.origin);
    if (url.protocol !== "https:" || url.origin !== policy.origin || url.username || url.password || (url.port && url.port !== "443") || result.has(policy.origin)) throw new Error("dependency_unavailable");
    if (policy.expiresAt && Date.parse(policy.expiresAt) <= Date.now()) continue;
    result.set(policy.origin, policy);
  }
  return result;
}
export function createProfileServices(options: { ledger: Ledger; apiKey: string; model: string; braveKey: string;
  fetcher?: typeof safeFetch; providerFetch?: typeof fetch; policies?: ReadonlyMap<string, UsagePolicy> }) {
  const fetcher = options.fetcher ?? safeFetch;
  const search = createBraveSearch({ apiKey: options.braveKey, ledger: options.ledger, fetch: options.providerFetch });
  const fetchPage = (url: string, ctx: Parameters<typeof safeFetch>[2]) => fetcher(url, "html", ctx);
  return { ledger: options.ledger,
    resolve: createResolver({ lookup: createWikidataLookup({ fetch: options.providerFetch }), search, fetchPage }),
    discover: createDiscoveryPlanner({ search, fetchPage, publisherPolicies: options.policies }),
    prepare: createImagePreparer(fetcher), ai: createOpenAiAdapter({ apiKey: options.apiKey, model: options.model }, { ledger: options.ledger }) };
}
export type ProfileServices = ReturnType<typeof createProfileServices>;
export async function productionServices(): Promise<ProfileServices> {
  const { config } = await import("@/server/config");
  if (!config.ai.apiKey || !config.brave.apiKey || !process.env.CRAWLER_CONTACT_URL) throw new Error("dependency_unavailable");
  return createProfileServices({ ledger: await productionLedger(), apiKey: config.ai.apiKey, model: config.ai.model, braveKey: config.brave.apiKey,
    policies: readPublisherPolicies(process.env.PUBLISHER_POLICIES_JSON) });
}
