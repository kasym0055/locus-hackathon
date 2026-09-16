import type { Ledger } from "@/server/usage/ledger";
import { productionLedger } from "@/server/usage/ledger";
import { createResolver } from "@/server/discovery/resolver";
import { createDiscoveryPlanner } from "@/server/discovery/planner";
import { createWikidataLookup } from "@/server/discovery/wikidata";
import { createBraveSearch } from "@/server/discovery/brave";
import { httpUrl } from "@/server/discovery/http";
import { safeFetch } from "@/server/fetch/safe-fetch";
import { createImagePreparer, ImageFailure } from "@/server/images/prepare";
import { createOpenAiAdapter } from "@/server/ai/openai";
import type { UsagePolicy } from "@/server/contracts";
import { policySchema } from "@/lib/event-schema";
import { z } from "zod";
import { documentedPolicyFor, mergePolicy } from "@/server/sources/usage-policy";
import type { Candidate, RunContext } from "@/server/contracts";

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
  const prepare = async (candidate: Candidate, ctx: RunContext) => {
    let policy = candidate.policy, displayUrl = candidate.imageUrl;
    const checked = new Set<string>();
    const requirePermission = (url: string) => {
      const grant = documentedPolicyFor(url, options.policies);
      if (!grant || grant.display !== "direct_permitted" || grant.retention === "disallowed") throw new ImageFailure("policy_unknown");
      if (!checked.has(grant.origin)) { policy = mergePolicy(policy, grant); checked.add(grant.origin); }
    };
    const prepared = await createImagePreparer(async (url, kind, context) => {
      requirePermission(url);
      const result = await fetcher(url, kind, context);
      // The observed chain must agree with the inspected resource, including
      // intermediate origins. Malformed metadata cannot attest to permission.
      const chain = result.redirectUrls ?? [];
      const validUrl = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && httpUrl(value) && new URL(value).href === value;
      if (!Array.isArray(chain) || chain.length > 3 || !chain.every(validUrl) || !validUrl(result.finalUrl)
        || (chain.length ? chain.at(-1) !== result.finalUrl : result.finalUrl !== url)) throw new ImageFailure("policy_unknown");
      for (const destination of [...chain, result.finalUrl]) requirePermission(destination);
      displayUrl = result.finalUrl;
      return result;
    })(candidate, ctx);
    return { ...prepared, candidate: { ...candidate, imageUrl: displayUrl, policy,
      evidence: candidate.evidence.map(evidence => ({ ...evidence, source: { ...evidence.source, policy } })) } };
  };
  return { ledger: options.ledger,
    resolve: createResolver({ lookup: createWikidataLookup({ fetch: options.providerFetch }), search, fetchPage }),
    discover: createDiscoveryPlanner({ search, fetchPage, publisherPolicies: options.policies }),
    prepare, ai: createOpenAiAdapter({ apiKey: options.apiKey, model: options.model }, { ledger: options.ledger }) };
}
export type ProfileServices = ReturnType<typeof createProfileServices>;
export async function productionServices(): Promise<ProfileServices> {
  const { config } = await import("@/server/config");
  if (!config.ai.apiKey || !config.brave.apiKey || !process.env.CRAWLER_CONTACT_URL) throw new Error("dependency_unavailable");
  return createProfileServices({ ledger: await productionLedger(), apiKey: config.ai.apiKey, model: config.ai.model, braveKey: config.brave.apiKey,
    policies: readPublisherPolicies(process.env.PUBLISHER_POLICIES_JSON) });
}
