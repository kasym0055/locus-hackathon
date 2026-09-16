import { load } from "cheerio";
import type { Candidate, Category, RunContext, University, UsagePolicy } from "@/server/contracts";
import { safeFetch } from "@/server/fetch/safe-fetch";
import { extractCandidates } from "@/server/sources/publisher";
import { documentedPolicyFor, mergePolicy } from "@/server/sources/usage-policy";
import { searchBrave, type Search } from "./brave";
import { assertActive, httpUrl } from "./http";
import { publisherIdentityPolicy, type PageFetcher } from "./resolver";

export function createDiscoveryPlanner(dependencies: { fetchPage?: PageFetcher; search?: Search; publisherPolicies?: ReadonlyMap<string, UsagePolicy> } = {}) {
  const fetchPage = dependencies.fetchPage ?? ((url, ctx) => safeFetch(url, "html", ctx));
  const search = dependencies.search ?? searchBrave;
  return async (university: University, gaps: Category[], ctx: RunContext): Promise<Candidate[]> => {
    assertActive(ctx);
    if (!gaps.length || !university.officialDomains.length) return [];
    const visited = new Set<string>();
    const navigation: string[] = [];
    let lastFailure: unknown;
    const official = (url: string) => university.officialDomains.some((domain) => {
      const host = new URL(url).hostname; return host === domain || host.endsWith(`.${domain}`);
    });
    async function inspect(url: string, policy: UsagePolicy, expectedImage?: string): Promise<Candidate[]> {
      if (!httpUrl(url) || visited.has(url) || visited.size >= 8) return [];
      visited.add(url);
      try {
        const page = await fetchPage(url, ctx);
        assertActive(ctx);
        if (official(page.finalUrl)) {
          const $ = load(new TextDecoder().decode(page.bytes));
          for (const element of $("a[href]").toArray()) {
            const anchor = $(element);
            if (!/campus|gallery|facilit|library|student|общежит|кампус|кітапхана|библиотек/iu.test(`${anchor.text()} ${anchor.attr("href")}`)) continue;
            try { const target = new URL(anchor.attr("href")!, page.finalUrl); target.hash = "";
              if (httpUrl(target.href) && official(target.href) && !navigation.includes(target.href)) navigation.push(target.href);
            } catch { /* invalid publisher navigation is not a candidate */ }
          }
        }
        const grant = dependencies.publisherPolicies?.get(new URL(page.finalUrl).origin);
        // Identity policy is not an image license. A documented direct-discovery
        // grant can supply one; search-derived restrictions still remain binding.
        const inherited = policy === publisherIdentityPolicy && grant ? grant : policy;
        return extractCandidates(page, university, inherited, grant).filter((candidate) =>
          (!expectedImage || candidate.imageUrl === expectedImage) && !/\.(svg|gif)(?:\?|$)/i.test(candidate.imageUrl)
          && candidate.evidence.some((evidence) => evidence.association !== "none" && !evidence.forbidden))
          .slice(0, 40).map((candidate) => {
            const imageGrant = documentedPolicyFor(candidate.imageUrl, dependencies.publisherPolicies);
            const imagePolicy = imageGrant ?? { ...candidate.policy, display: "link_only" as const,
              basis: ["Image origin display permission not established"] };
            const policy = mergePolicy(candidate.policy, imagePolicy);
            return { ...candidate, policy, categoryHint: gaps[0], evidence: candidate.evidence.map(evidence =>
              ({ ...evidence, source: { ...evidence.source, policy } })) };
          });
      } catch (error) { assertActive(ctx); lastFailure = error; return []; }
    }
    for (const domain of university.officialDomains.slice(0, 2)) {
      const candidates = await inspect(`https://${domain}/`, publisherIdentityPolicy);
      if (candidates.length) return candidates;
    }
    for (const url of navigation.slice(0, 2)) {
      const candidates = await inspect(url, publisherIdentityPolicy);
      if (candidates.length) return candidates;
    }
    const terms = gaps.slice(0, 3).map((category) => category.replaceAll("_", " ")).join(" ");
    for (const domain of university.officialDomains.slice(0, 2)) {
      const results = await search({ query: `site:${domain} ${university.name} ${terms}`, kind: "web" }, ctx);
      for (const result of results.slice(0, 3)) {
        if (!official(result.pageUrl)) continue;
        const candidates = await inspect(result.pageUrl, result.policy);
        if (candidates.length) return candidates;
      }
    }
    // Broader images are reached only after an actual official retrieval gap.
    const results = await search({ query: `${university.name} ${university.city} ${terms}`, kind: "images" }, ctx);
    for (const result of results.slice(0, 4)) {
      const candidates = await inspect(result.pageUrl, result.policy, result.imageUrl);
      if (candidates.length) return candidates;
    }
    if (lastFailure) throw lastFailure;
    return [];
  };
}
export const discover = createDiscoveryPlanner();
