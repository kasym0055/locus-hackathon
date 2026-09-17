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
interface PublisherInstitution { name: string; city: string; country: string; website?: string }
type ResolverAttemptSource = "wikidata_website" | "search_result";
type ResolverAttemptOutcome = "fetch_unavailable" | "origin_mismatch" | "structured_location_conflict"
  | "name_mismatch" | "location_missing" | "official_contact_missing" | "entity_link_missing";
export interface ResolverNotFoundReport {
  event: "resolver_not_found";
  requestId: string;
  lookupCount: number;
  relevantCount: number;
  searchResultCount: number;
  inspectedCount: number;
  attempts: Array<{ target: number; source: ResolverAttemptSource; outcome: ResolverAttemptOutcome }>;
  elapsedMs: number;
}
export type ResolverNotFoundSink = (report: ResolverNotFoundReport) => void;
function structuredInstitutions($: CheerioAPI): PublisherInstitution[] {
  const institutions: PublisherInstitution[] = [];
  for (const element of $("script[type='application/ld+json']").toArray().slice(0, 8)) {
    const raw = $(element).text();
    if (raw.length > 20_000) continue;
    try {
      const root: unknown = JSON.parse(raw);
      const nodes = Array.isArray(root) ? root : root && typeof root === "object" && "@graph" in root && Array.isArray(root["@graph"]) ? root["@graph"] : [root];
      for (const node of nodes.slice(0, 30)) {
        if (!node || typeof node !== "object" || typeof node.name !== "string" || !node.name.trim()) continue;
        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (!types.some((type: unknown) => ["CollegeOrUniversity", "EducationalOrganization", "University"].includes(String(type)))) continue;
        const address = node.address;
        if (address && typeof address.addressLocality === "string" && typeof address.addressCountry === "string"
          && address.addressLocality.trim() && address.addressCountry.trim()) institutions.push({ name: node.name.trim(), city: address.addressLocality.trim(), country: address.addressCountry.trim(),
            ...(typeof node.url === "string" && httpUrl(node.url) ? { website: node.url } : {}) });
        if (institutions.length >= 30) return institutions;
      }
    } catch { /* Invalid publisher JSON-LD grants no identity evidence. */ }
  }
  return institutions;
}
function structuredLocation($: CheerioAPI, identity: WikidataIdentity): PublisherInstitution | undefined {
  const names = [identity.name, ...identity.aliases].map(normalizeQuery);
  return structuredInstitutions($).find((institution) => names.includes(normalizeQuery(institution.name)));
}
function publisherDocument(page: FetchResult): CheerioAPI {
  const $ = load(new TextDecoder().decode(page.bytes));
  $("script:not([type='application/ld+json']), style, template, noscript").remove();
  return $;
}
function separatePublisher(a: string, b: string): boolean {
  // Conservative grouping also excludes sibling subdomains. Shared public suffixes
  // such as co.uk may withhold a valid pair; they must never manufacture independence.
  const scope = (value: string) => new URL(value).hostname.split(".").slice(-2).join(".");
  return scope(a) !== scope(b);
}
function identityPagePriority(value: string): number {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLocaleLowerCase("und");
    if (/contact|kontakt|контакт|байланыс/iu.test(path)) return 2;
    if (/about|location|visit/iu.test(path)) return 1;
  } catch { /* Search records are validated separately; an invalid URL ranks last. */ }
  return 0;
}

function hasOfficialContact($: CheerioAPI, domain: string, city: string, country: string): boolean {
  const scopes = new Set<string>();
  const add = (element: Parameters<CheerioAPI>[0]) => {
    const node = $(element);
    const links = [
      ...(node.is("a[href^='mailto:']") ? [node.attr("href")] : []),
      ...node.find("a[href^='mailto:']").toArray().map((anchor) => $(anchor).attr("href")),
    ].filter((value): value is string => Boolean(value)).map((value) => value.slice(7).split("?")[0]);
    const visible = [...node.toArray(), ...node.find("*").toArray()].flatMap((item) => $(item).contents().toArray())
      .filter((item) => item.type === "text").map((item) => $(item).text()).join(" ");
    const text = normalizeQuery(`${visible} ${links.join(" ")}`);
    if (text && text.length <= 5_000) scopes.add(text);
  };
  $("address, [itemprop='address'], footer, [class*='contact'], [id*='contact']").toArray().forEach(add);
  for (const anchor of $("a[href^='mailto:']").toArray()) {
    let node = $(anchor);
    for (let depth = 0; depth < 8 && node.length; depth++, node = node.parent()) add(node[0]);
  }
  return [...scopes].some((text) => {
    const location = text.includes(normalizeQuery(city)) && text.includes(normalizeQuery(country));
    const email = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+(?:@|\s*(?:\(\s*at\s*\)|\[\s*at\s*\])\s*)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu)
      ?.some((address) => {
        const canonical = address.replace(/\s*(?:\(\s*at\s*\)|\[\s*at\s*\])\s*/iu, "@");
        const host = canonical.split("@").at(-1)?.toLowerCase();
        return host === domain || host?.endsWith(`.${domain}`);
      });
    return location && email === true;
  });
}

export function createResolver(dependencies: { lookup?: Lookup; search?: Search; fetchPage?: PageFetcher;
  onNotFound?: ResolverNotFoundSink } = {}) {
  const lookup = dependencies.lookup ?? lookupWikidata;
  const search = dependencies.search ?? searchBrave;
  const fetchPage = dependencies.fetchPage ?? ((url, ctx) => safeFetch(url, "html", ctx));
  const onNotFound = dependencies.onNotFound ?? ((report: ResolverNotFoundReport) => console.warn(JSON.stringify(report)));
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
      const pages = new Map<string, FetchResult | undefined>();
      const targets = new Map<string, number>();
      const attempts: ResolverNotFoundReport["attempts"] = [];
      let searchResultCount = 0;
      const target = (url: string) => {
        const existing = targets.get(url);
        if (existing) return existing;
        const id = targets.size + 1; targets.set(url, id); return id;
      };
      const rejected = (url: string, source: ResolverAttemptSource, outcome: ResolverAttemptOutcome) => {
        if (attempts.length < 8) attempts.push({ target: target(url), source, outcome });
      };
      async function inspect(url: string): Promise<FetchResult | undefined> {
        if (pages.has(url)) return pages.get(url);
        if (!httpUrl(url) || pages.size >= 6) return;
        pages.set(url, undefined);
        try {
          ctx.publisherPhase = "identity";
          const page = await fetchPage(url, ctx);
          assertActive(ctx);
          pages.set(url, page);
          return page;
        } catch { assertActive(ctx); failed = true; }
      }

      async function verify(identity: WikidataIdentity, url: string, inherited?: UsagePolicy,
        independentSources?: SourceRef[], attemptSource: ResolverAttemptSource = "search_result") {
        try {
          const page = await inspect(url);
          if (!page) { rejected(url, attemptSource, "fetch_unavailable"); return; }
          const domain = identity.website ? new URL(identity.website).hostname : new URL(url).hostname;
          if (!sameHost(page.finalUrl, domain)) { rejected(url, attemptSource, "origin_mismatch"); return; }
          const $ = publisherDocument(page);
          const headings = $("title, h1").toArray().map((element) => normalizeQuery($(element).text()));
          const matchingName = [identity.name, ...identity.aliases].some((name) => headings.some((heading) => heading.includes(normalizeQuery(name))));
          const structured = structuredLocation($, identity);
          if (structured && ((identity.city && normalizeQuery(identity.city) !== normalizeQuery(structured.city))
            || (identity.country && normalizeQuery(identity.country) !== normalizeQuery(structured.country)))) {
            rejected(url, attemptSource, "structured_location_conflict"); return;
          }
          const city = identity.city ?? structured?.city;
          const country = identity.country ?? structured?.country;
          if (!matchingName) { rejected(url, attemptSource, "name_mismatch"); return; }
          if (!city || !country) { rejected(url, attemptSource, "location_missing"); return; }
          const sameAs = $("a[href]").toArray().some((element) => $(element).attr("href") === `https://www.wikidata.org/wiki/${identity.entityId}`)
            || $("script[type='application/ld+json']").toArray().some((element) => $(element).text().includes(`https://www.wikidata.org/wiki/${identity.entityId}`));
          // A missing Wikidata website needs an explicit entity link on the original page.
          if (!hasOfficialContact($, domain, city, country)) { rejected(url, attemptSource, "official_contact_missing"); return; }
          if (!identity.website && !sameAs) { rejected(url, attemptSource, "entity_link_missing"); return; }
          const publisherPolicy = inherited ? mergePolicy(inherited, publisherIdentityPolicy) : publisherIdentityPolicy;
          resolved.set(identity.entityId, { id: identity.entityId, name: identity.name, aliases: identity.aliases,
            campus: city, city, country, officialDomains: [domain], sources: [
              ...(independentSources ?? [source(`https://www.wikidata.org/wiki/${identity.entityId}`, wikidataPolicy)]),
              source(page.finalUrl, publisherPolicy, page.retrievedAt),
            ] });
        } catch { assertActive(ctx); failed = true; }
      }

      async function recoverFromPublishers(records: DiscoveryRecord[]) {
        const inspected: Array<{ record: DiscoveryRecord; page: FetchResult; document: CheerioAPI; institutions: PublisherInstitution[] }> = [];
        for (const record of records.slice(0, 5)) {
          const page = await inspect(record.pageUrl);
          if (!page) continue;
          const document = publisherDocument(page);
          inspected.push({ record, page, document, institutions: structuredInstitutions(document).filter((item) => normalizeQuery(item.name) === normalized) });
        }
        for (const primary of inspected) {
          for (const institution of primary.institutions) {
            if (!institution.website || !sameHost(primary.page.finalUrl, new URL(institution.website).hostname)) continue;
            const domain = new URL(institution.website).hostname;
            const conflict = inspected.some((other) => separatePublisher(primary.page.finalUrl, other.page.finalUrl)
              && other.institutions.some((item) => item.website && new URL(item.website).hostname === domain
                && (normalizeQuery(item.city) !== normalizeQuery(institution.city) || normalizeQuery(item.country) !== normalizeQuery(institution.country))));
            if (conflict) continue;
            const corroborating = inspected.find((other) => {
              if (!separatePublisher(primary.page.finalUrl, other.page.finalUrl)) return false;
              const matching = other.institutions.some((item) => item.website && new URL(item.website).hostname === domain
                && normalizeQuery(item.city) === normalizeQuery(institution.city) && normalizeQuery(item.country) === normalizeQuery(institution.country));
              const visible = other.document("body").clone(); visible.find("script").remove();
              const text = normalizeQuery(visible.text());
              const linked = other.document("a[href]").toArray().some((element) => {
                try { return new URL(other.document(element).attr("href")!, other.page.finalUrl).hostname === domain; } catch { return false; }
              });
              return matching && linked && [institution.name, institution.city, institution.country].every((value) => text.includes(normalizeQuery(value)));
            });
            if (!corroborating) continue;
            const independentSource = source(corroborating.page.finalUrl, mergePolicy(corroborating.record.policy, publisherIdentityPolicy), corroborating.page.retrievedAt);
            await verify({ entityId: `publisher:${identifier(`${domain}|${normalized}|${institution.city}|${institution.country}`)}`,
              ...institution, aliases: [] }, primary.record.pageUrl, primary.record.policy, [independentSource], "search_result");
          }
        }
      }

      for (const identity of relevant) {
        if (identity.website) await verify(identity, identity.website, undefined, undefined, "wikidata_website");
      }
      if (resolved.size !== relevant.length || relevant.length === 0) {
        let records: DiscoveryRecord[] = [];
        try { records = await search({ query: `${query.query} ${query.countryHint} official university contact`, kind: "web" }, ctx); }
        catch { assertActive(ctx); failed = true; }
        searchResultCount = records.length;
        if (!relevant.length) await recoverFromPublishers(records);
        for (const identity of relevant) {
          const candidates = records.filter((record) => !identity.website || sameHost(record.pageUrl, new URL(identity.website).hostname))
            .map((record, index) => ({ record, index, priority: identityPagePriority(record.pageUrl) }))
            .sort((a, b) => b.priority - a.priority || a.index - b.index).slice(0, 2);
          for (const { record } of candidates) {
            if (resolved.has(identity.entityId)) break;
            await verify(identity, record.pageUrl, record.policy, undefined, "search_result");
          }
        }
      }
      const universities = [...resolved.values()];
      // An unreachable exact-name competitor is still a competing identity.
      // Never let an outage silently turn an ambiguous query into a unique result.
      if (relevant.length > 1 && relevant.some((identity) => !resolved.has(identity.entityId))) return { kind: "unavailable", code: "dependency_unavailable" };
      if (universities.length > 1) return { kind: "needs_selection", choices: universities.map((university) => ({
        name: university.name, campus: university.campus, city: university.city, country: university.country,
        officialDomain: university.officialDomains[0], source: university.sources[1],
        // Task 6 adds authenticated selection state. Never accept an unsigned selection here.
        selectionToken: "",
      })) };
      if (universities.length === 1) return { kind: "resolved", university: universities[0] };
      if (failed) return { kind: "unavailable", code: "dependency_unavailable" };
      try { onNotFound({ event: "resolver_not_found", requestId: ctx.requestId, lookupCount: identities.length,
        relevantCount: relevant.length, searchResultCount, inspectedCount: pages.size,
        attempts, elapsedMs: Math.max(0, Date.now() - ctx.startedAt) }); } catch { /* Diagnostics never affect resolution. */ }
      return { kind: "not_found" };
    } catch (error) {
      return { kind: "unavailable", code: error instanceof DiscoveryFailure ? error.code : "dependency_unavailable" };
    }
  };
}
export const resolveUniversity = createResolver();
