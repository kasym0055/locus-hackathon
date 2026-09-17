import { load } from "cheerio";
import type { Candidate, Category, Evidence, RunContext, University, UsagePolicy } from "@/server/contracts";
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
    const licensedPublisherFiles: string[] = [];
    const officialSupport: Evidence[] = [];
    let fallback: Candidate[] = [];
    let lastFailure: unknown;
    const commons = dependencies.publisherPolicies?.get("https://commons.wikimedia.org");
    const uploads = dependencies.publisherPolicies?.get("https://upload.wikimedia.org");
    const licensedPublisherReady = commons?.display === "direct_permitted" && commons.retention !== "disallowed"
      && uploads?.display === "direct_permitted" && uploads.retention !== "disallowed";
    const official = (url: string) => university.officialDomains.some((domain) => {
      const host = new URL(url).hostname; return host === domain || host.endsWith(`.${domain}`);
    });
    async function inspect(url: string, policy: UsagePolicy, expectedImage?: string, phase: RunContext["publisherPhase"] = "official_discovery"): Promise<Candidate[]> {
      if (!httpUrl(url) || visited.has(url) || visited.size >= 8) return [];
      visited.add(url);
      try {
        ctx.publisherPhase = phase;
        const page = await fetchPage(url, ctx);
        assertActive(ctx);
        const pageUrl = new URL(page.finalUrl);
        const $ = load(new TextDecoder().decode(page.bytes));
        if (pageUrl.origin === "https://commons.wikimedia.org" && /^\/wiki\/Category(?::|%3A)/i.test(pageUrl.pathname)) {
          for (const element of $('a[href^="/wiki/File:"]').toArray()) {
            try {
              const target = new URL($(element).attr("href")!, page.finalUrl); target.hash = "";
              const title = decodeURIComponent(target.pathname).toLocaleLowerCase("und");
              if (target.origin !== pageUrl.origin || !/^\/wiki\/File:/i.test(target.pathname)
                || /(?:emblem|logo|logotype|delegation|gala|conference|presenting|portrait|visitors?['’_%]*_?book)/iu.test(title)
                || licensedPublisherFiles.includes(target.href)) continue;
              licensedPublisherFiles.push(target.href);
              if (licensedPublisherFiles.length === 8) break;
            } catch { /* invalid publisher navigation is not a candidate */ }
          }
          return [];
        }
        if (official(page.finalUrl)) {
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
    // M1 corroborates only narrowly named, campus-specific objects. Generic
    // facilities such as a library or dormitory are not unique enough.
    const objectTerms = [["main atrium", "atrium"], ["main building", "administrative building"], ["clock tower"]];
    const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
    const candidateObject = (candidate: Candidate) => {
      const primary = candidate.evidence[0];
      if (!primary || primary.authority !== "attributable" || primary.association !== "explicit") return;
      const text = normalized(primary.excerpt.split("\n\n")[0]);
      return objectTerms.find((terms) => terms.some((term) => text.includes(term)));
    };
    const retainOfficialSupport = (candidates: Candidate[]) => {
      for (const candidate of candidates) for (const evidence of candidate.evidence) {
        if (evidence.authority !== "official" || evidence.association === "none") continue;
        if (!officialSupport.some(({ source }) => source.id === evidence.source.id)) officialSupport.push(evidence);
      }
    };
    const corroborate = (candidate: Candidate): Candidate => {
      const primary = candidate.evidence[0];
      const object = candidateObject(candidate);
      if (!object) return candidate;
      const support = officialSupport.find((evidence) => {
        try { return new URL(evidence.source.url).origin !== new URL(primary.source.url).origin
          && object.some((term) => normalized(evidence.excerpt).includes(term)); }
        catch { return false; }
      });
      if (!support) return candidate;
      const supporting = { source: support.source, imageId: primary.imageId, excerpt: support.excerpt.slice(0, 2_000),
        independent: true, locationSupported: true };
      return { ...candidate, evidence: candidate.evidence.map((evidence, index) => index ? evidence : { ...evidence,
        independentEquivalent: true, corroboration: 20, corroborationEvidenceIds: [support.source.id],
        corroborationSources: [supporting] }) };
    };
    const eligible = (candidates: Candidate[], officialPass = false) => {
      if (!candidates.length) return [];
      if (!fallback.length) fallback = candidates;
      if (officialPass) retainOfficialSupport(candidates);
      return candidates.filter((candidate) => candidate.policy.display === "direct_permitted" && candidate.policy.retention !== "disallowed")
        .map(corroborate).filter((candidate) => candidate.evidence.some((evidence) => evidence.association === "explicit"
          && (evidence.authority === "official" || evidence.independentEquivalent)));
    };
    // A later file depicting the same object must not restart its search/allowance.
    const searchedObjects = new Set<string[]>();
    const findOfficialCorroboration = async (candidates: Candidate[]) => {
      const object = candidates.map(candidateObject).find((value) => value !== undefined);
      if (!object || searchedObjects.has(object)) return;
      searchedObjects.add(object);
      const term = [...object].sort((a, b) => a.length - b.length)[0];
      for (const domain of university.officialDomains.slice(0, 1)) {
        const query = `site:${domain} "${term}" ${university.name}`.slice(0, 400);
        const results = await search({ query, kind: "web" }, ctx);
        let attempts = 0;
        for (const result of results) {
          if (attempts >= 2) break;
          if (!httpUrl(result.pageUrl) || !official(result.pageUrl) || visited.has(result.pageUrl)) continue;
          attempts++;
          retainOfficialSupport(await inspect(result.pageUrl, result.policy, undefined, "official_corroboration"));
          if (candidates.some(candidate => candidateObject(candidate) === object
            && corroborate(candidate).evidence[0]?.independentEquivalent)) return;
        }
      }
    };
    const terms = gaps.slice(0, 3).map((category) => category.replaceAll("_", " ")).join(" ");
    if (!licensedPublisherReady) {
      for (const domain of university.officialDomains.slice(0, 2)) {
        const candidates = await inspect(`https://${domain}/`, publisherIdentityPolicy);
        const admitted = eligible(candidates, true);
        if (admitted.length) return admitted;
      }
      for (const url of navigation.slice(0, 1)) {
        const candidates = await inspect(url, publisherIdentityPolicy);
        const admitted = eligible(candidates, true);
        if (admitted.length) return admitted;
      }
      for (const domain of university.officialDomains.slice(0, 2)) {
        const results = await search({ query: `site:${domain} ${university.name} ${terms}`, kind: "web" }, ctx);
        // Preserve the bounded shared page budget for the licensed-image
        // fallback. The strongest official result is sufficient for M1 evidence.
        for (const result of results.slice(0, 1)) {
          if (!official(result.pageUrl)) continue;
          const candidates = await inspect(result.pageUrl, result.policy);
          const admitted = eligible(candidates, true);
          if (admitted.length) return admitted;
        }
      }
    }
    if (licensedPublisherReady) {
      const title = encodeURIComponent(university.name.replace(/\s+/gu, "_"));
      const licensedPublisherDiscoveryPolicy = { ...publisherIdentityPolicy };
      await inspect(`https://commons.wikimedia.org/wiki/Category:${title}`, licensedPublisherDiscoveryPolicy, undefined, "licensed_category");
      for (const file of licensedPublisherFiles) {
        const candidates = await inspect(file, licensedPublisherDiscoveryPolicy, undefined, "licensed_file");
        let admitted = eligible(candidates);
        if (!admitted.length) {
          await findOfficialCorroboration(candidates);
          admitted = eligible(candidates);
        }
        if (admitted.length) return admitted;
      }
    }
    // Broader images are reached only after an actual official retrieval gap.
    const results = await search({ query: `${university.name} ${university.city} ${terms}`, kind: "images" }, ctx);
    for (const result of results.slice(0, 4)) {
      const candidates = await inspect(result.pageUrl, result.policy, result.imageUrl, "image_search");
      let admitted = eligible(candidates);
      if (!admitted.length) {
        await findOfficialCorroboration(candidates);
        admitted = eligible(candidates);
      }
      if (admitted.length) return admitted;
    }
    if (lastFailure) throw lastFailure;
    return fallback;
  };
}
export const discover = createDiscoveryPlanner();
