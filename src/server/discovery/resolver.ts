import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { FetchResult, ProfileQuery, Resolution, RunContext, SourceRef, University, UsagePolicy } from "@/server/contracts";
import { safeFetch } from "@/server/fetch/safe-fetch";
import { mergePolicy } from "@/server/sources/usage-policy";
import { searchBrave, type DiscoveryRecord, type Search } from "./brave";
import { lookupWikidata, wikidataPolicy, type Lookup, type WikidataIdentity } from "./wikidata";
import { assertActive, DiscoveryFailure, httpUrl } from "./http";

export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
export type PageFetcher = (url: string, ctx: RunContext) => Promise<FetchResult>;
export const publisherIdentityPolicy: UsagePolicy = { origin: "publisher", policyVersion: "v1", retention: "transient_only", display: "link_only", basis: ["Original publisher identity evidence; image permissions not established"] };
const identifier = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHost = (url: string, domain: string) => {
  const host = new URL(url).hostname;
  return host === domain || host.endsWith(`.${domain}`);
};
function source(url: string, policy: UsagePolicy, retrievedAt = new Date().toISOString()): SourceRef {
  return { id: identifier(url), url, policy, retrievedAt };
}
function structuredLocation($: CheerioAPI, identity: WikidataIdentity): { city: string; country: string } | undefined {
  const names = [identity.name, ...identity.aliases].map(normalizeQuery);
  for (const element of $("script[type='application/ld+json']").toArray().slice(0, 8)) {
    const raw = $(element).text();
    if (raw.length > 20_000) continue;
    try {
      const root: unknown = JSON.parse(raw);
      const nodes = Array.isArray(root) ? root : root && typeof root === "object" && "@graph" in root && Array.isArray(root["@graph"]) ? root["@graph"] : [root];
      for (const node of nodes.slice(0, 30)) {
        if (!node || typeof node !== "object" || typeof node.name !== "string" || !names.includes(normalizeQuery(node.name))) continue;
        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (!types.some((type: unknown) => ["CollegeOrUniversity", "EducationalOrganization", "University"].includes(String(type)))) continue;
        const address = node.address;
        if (address && typeof address.addressLocality === "string" && typeof address.addressCountry === "string"
          && address.addressLocality.trim() && address.addressCountry.trim()) return { city: address.addressLocality.trim(), country: address.addressCountry.trim() };
      }
    } catch { /* Invalid publisher JSON-LD grants no identity evidence. */ }
  }
}

export function createResolver(dependencies: { lookup?: Lookup; search?: Search; fetchPage?: PageFetcher } = {}) {
  const lookup = dependencies.lookup ?? lookupWikidata;
  const search = dependencies.search ?? searchBrave;
  const fetchPage = dependencies.fetchPage ?? ((url, ctx) => safeFetch(url, "html", ctx));
  return async (query: ProfileQuery, ctx: RunContext): Promise<Resolution> => {
    try {
      assertActive(ctx);
      const normalized = normalizeQuery(query.query);
      if (normalized.length < 2 || normalized.length > 160 || query.selectionToken) return { kind: "unavailable", code: "invalid_request" };
      let failed = false;
      let identities: WikidataIdentity[] = [];
      try { identities = await lookup(query.query, ctx); } catch (error) {
        assertActive(ctx); if (error instanceof DiscoveryFailure && error.code === "invalid_request") throw error; failed = true;
      }
      const relevant = identities.filter((item) => [item.name, ...item.aliases].some((name) => normalizeQuery(name) === normalized)).slice(0, 5);
      const resolved = new Map<string, University>();
      const visited = new Set<string>();

      async function verify(identity: WikidataIdentity, url: string, inherited?: UsagePolicy) {
        if (!httpUrl(url) || visited.size >= 6 || visited.has(url)) return;
        visited.add(url);
        try {
          const page = await fetchPage(url, ctx);
          assertActive(ctx);
          const domain = identity.website ? new URL(identity.website).hostname : new URL(url).hostname;
          if (!sameHost(page.finalUrl, domain)) return;
          const $ = load(new TextDecoder().decode(page.bytes));
          $("script:not([type='application/ld+json']), style, template, noscript").remove();
          const headings = $("title, h1").toArray().map((element) => normalizeQuery($(element).text()));
          const matchingName = [identity.name, ...identity.aliases].some((name) => headings.some((heading) => heading.includes(normalizeQuery(name))));
          const structured = structuredLocation($, identity);
          if (structured && ((identity.city && normalizeQuery(identity.city) !== normalizeQuery(structured.city))
            || (identity.country && normalizeQuery(identity.country) !== normalizeQuery(structured.country)))) return;
          const city = identity.city ?? structured?.city;
          const country = identity.country ?? structured?.country;
          if (!city || !country) return;
          const contact = normalizeQuery($("address, [itemprop='address'], footer, [class*='contact'], [id*='contact']").text());
          const email = $("a[href^='mailto:']").toArray().some((element) => {
            const value = $(element).attr("href")?.slice(7).split("?")[0] ?? "";
            const host = value.split("@")[1]?.toLowerCase();
            return host === domain || host?.endsWith(`.${domain}`);
          });
          const location = contact.includes(normalizeQuery(city)) && contact.includes(normalizeQuery(country));
          const sameAs = $("a[href]").toArray().some((element) => $(element).attr("href") === `https://www.wikidata.org/wiki/${identity.entityId}`)
            || $("script[type='application/ld+json']").toArray().some((element) => $(element).text().includes(`https://www.wikidata.org/wiki/${identity.entityId}`));
          // A missing Wikidata website needs an explicit entity link on the original page.
          if (!matchingName || !email || !location || (!identity.website && !sameAs)) return;
          const publisherPolicy = inherited ? mergePolicy(inherited, publisherIdentityPolicy) : publisherIdentityPolicy;
          resolved.set(identity.entityId, { id: identity.entityId, name: identity.name, aliases: identity.aliases,
            campus: city, city, country, officialDomains: [domain], sources: [
              source(`https://www.wikidata.org/wiki/${identity.entityId}`, wikidataPolicy),
              source(page.finalUrl, publisherPolicy, page.retrievedAt),
            ] });
        } catch { assertActive(ctx); failed = true; }
      }

      for (const identity of relevant) {
        if (identity.website) await verify(identity, identity.website);
      }
      if (resolved.size !== relevant.length || relevant.length === 0) {
        let records: DiscoveryRecord[] = [];
        try { records = await search({ query: `${query.query} ${query.countryHint} official university contact`, kind: "web" }, ctx); }
        catch { assertActive(ctx); failed = true; }
        for (const record of records.slice(0, 5)) {
          for (const identity of relevant) {
            if (resolved.has(identity.entityId)) continue;
            if (!identity.website || sameHost(record.pageUrl, new URL(identity.website).hostname)) await verify(identity, record.pageUrl, record.policy);
          }
        }
      }
      const universities = [...resolved.values()];
      if (universities.length > 1) return { kind: "needs_selection", choices: universities.map((university) => ({
        name: university.name, campus: university.campus, city: university.city, country: university.country,
        officialDomain: university.officialDomains[0], source: university.sources[1],
        // Task 6 adds authenticated selection state. Never accept an unsigned selection here.
        selectionToken: "",
      })) };
      if (universities.length === 1) return { kind: "resolved", university: universities[0] };
      return failed ? { kind: "unavailable", code: "dependency_unavailable" } : { kind: "not_found" };
    } catch (error) {
      return { kind: "unavailable", code: error instanceof DiscoveryFailure ? error.code : "dependency_unavailable" };
    }
  };
}
export const resolveUniversity = createResolver();
