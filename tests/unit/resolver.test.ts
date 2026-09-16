import { describe, expect, it } from "vitest";
import { normalizeQuery, createResolver } from "@/server/discovery/resolver";
import { contextFixture, publisherFixture, transientPolicy } from "../support/fixtures";

const identity = { entityId: "Q123", name: "Example University", aliases: ["Example Institute"],
  website: "https://example.edu/", city: "Example City", country: "Example Country" };
const official = `<html><title>Example University</title><body><h1>Example University</h1>
  <address>Example City, Example Country <a href="mailto:info@example.edu">Contact</a></address></body></html>`;

describe("conservative institution resolution", () => {
  it("normalizes spacing and Unicode without inventing an alias expansion", () => {
    expect(normalizeQuery("  Astana   IT University  ")).toBe("astana it university");
    expect(normalizeQuery("Ａｓｔａｎａ\u00a0IT University")).toBe("astana it university");
    expect(normalizeQuery("NU")).toBe("nu");
  });
  it("requires a matching original page and independent identity, retaining both sources and city", async () => {
    const resolve = createResolver({ lookup: async () => [identity], search: async () => [],
      fetchPage: async () => publisherFixture(official) });
    const result = await resolve({ query: "Example University", countryHint: "" }, contextFixture());
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("identity missing");
    expect(result.university).toMatchObject({ id: "Q123", city: "Example City", country: "Example Country", officialDomains: ["example.edu"] });
    expect(result.university.sources.map((source) => source.url)).toEqual(["https://www.wikidata.org/wiki/Q123", "https://example.edu/news/visit"]);
  });
  it.each([
    ["plain footer email", `<footer>Example University · Example City, Example Country · info@example.edu</footer>`],
    ["element-separated footer email", `<footer><span>Example University · Example City, Example Country</span><span>+1 555 0100</span><span>info@example.edu</span><span>License</span></footer>`],
    ["nonsemantic mail link container", `<div><div>Example University · Example City, Example Country <p><a href="mailto:info@example.edu">Contact</a></p></div></div>`],
  ])("accepts official-domain contact evidence in an observed publisher %s", async (_case, contact) => {
    const resolve = createResolver({ lookup: async () => [identity], search: async () => [],
      fetchPage: async () => publisherFixture(`<title>Example University</title><h1>Example University</h1>${contact}`) });
    expect(await resolve({ query: identity.name, countryHint: "" }, contextFixture())).toMatchObject({
      kind: "resolved", university: { city: "Example City", country: "Example Country" },
    });
  });
  it("rejects a matching title without contact/city corroboration and attempts fallback", async () => {
    const searches: string[] = [];
    const resolve = createResolver({ lookup: async () => [identity],
      search: async (input) => { searches.push(input.query); return []; },
      fetchPage: async () => publisherFixture("<h1>Example University</h1>") });
    expect((await resolve({ query: identity.name, countryHint: "" }, contextFixture())).kind).not.toBe("resolved");
    expect(searches).toHaveLength(1);
  });
  it("returns competing credible identities instead of choosing the first", async () => {
    const resolve = createResolver({ lookup: async () => [identity, { ...identity, entityId: "Q456", website: "https://example2.edu/" }],
      search: async () => [], fetchPage: async (url) => ({ ...publisherFixture(official.replaceAll("example.edu", new URL(url).hostname)), finalUrl: url }) });
    const result = await resolve({ query: identity.name, countryHint: "" }, contextFixture());
    expect(result.kind).toBe("needs_selection");
    if (result.kind === "needs_selection") expect(result.choices).toHaveLength(2);
  });
  it("reports failed dependencies instead of inventing a domain", async () => {
    const resolve = createResolver({ lookup: async () => { throw new Error("offline"); },
      search: async () => { throw new Error("offline"); }, fetchPage: async () => { throw new Error("disabled"); } });
    expect(await resolve({ query: identity.name, countryHint: "" }, contextFixture())).toEqual({ kind: "unavailable", code: "dependency_unavailable" });
  });
  it("uses explicit official structured location when Wikidata has only the independent name and website", async () => {
    const resolve = createResolver({ lookup: async () => [{ ...identity, city: undefined, country: undefined }], search: async () => [],
      fetchPage: async () => publisherFixture(`${official}<script type="application/ld+json">${JSON.stringify({ "@type": "CollegeOrUniversity", name: identity.name,
        address: { "@type": "PostalAddress", addressLocality: "Example City", addressCountry: "Example Country" } })}</script>`) });
    expect(await resolve({ query: identity.name, countryHint: "" }, contextFixture())).toMatchObject({ kind: "resolved", university: { city: "Example City", country: "Example Country" } });
  });
  it("does not resolve a publisher structured location that conflicts with Wikidata", async () => {
    const resolve = createResolver({ lookup: async () => [identity], search: async () => [],
      fetchPage: async () => publisherFixture(`${official}<script type="application/ld+json">${JSON.stringify({ "@type": "CollegeOrUniversity", name: identity.name,
        address: { addressLocality: "Different City", addressCountry: "Example Country" } })}</script>`) });
    expect((await resolve({ query: identity.name, countryHint: "" }, contextFixture())).kind).not.toBe("resolved");
  });
  it("does not trust a redirect outside the independently supplied official domain", async () => {
    const resolve = createResolver({ lookup: async () => [identity], search: async () => [],
      fetchPage: async () => ({ ...publisherFixture(official), finalUrl: "https://unrelated.example/" }) });
    expect((await resolve({ query: identity.name, countryHint: "" }, contextFixture())).kind).not.toBe("resolved");
  });
  it("does not select the surviving exact-name identity when a credible competitor is unavailable", async () => {
    const inspected: string[] = [];
    const resolve = createResolver({ lookup: async () => [identity, { ...identity, entityId: "Q456", website: "https://example2.edu/" }], search: async () => [],
      fetchPage: async (url) => { inspected.push(url); if (url.includes("example2")) throw new Error("publisher offline"); return publisherFixture(official); } });
    expect(await resolve({ query: identity.name, countryHint: "" }, contextFixture())).toEqual({ kind: "unavailable", code: "dependency_unavailable" });
    expect(inspected).toEqual(["https://example.edu/", "https://example2.edu/"]);
  });
  it.each([false, true])("inspects original Brave pages and requires independent corroboration (present=%s)", async (corroborated) => {
    const institutionData = JSON.stringify({ "@type": "CollegeOrUniversity", name: identity.name, url: identity.website,
      address: { addressLocality: identity.city, addressCountry: identity.country } });
    const inspected: string[] = [];
    const resolve = createResolver({ lookup: async () => [], search: async () => [
      { pageUrl: "https://example.edu/", policy: transientPolicy },
      { pageUrl: "https://independent.example/directory", policy: transientPolicy },
    ], fetchPage: async (url) => {
      inspected.push(url);
      const html = url.includes("independent")
        ? (corroborated ? `<title>Independent university directory</title><article><h1>Example University</h1><p>Example City, Example Country</p>
          <a href="https://example.edu/">University website</a><script type="application/ld+json">${institutionData}</script></article>` : "<h1>Unrelated directory</h1>")
        : `${official}<script type="application/ld+json">${institutionData}</script>`;
      return { ...publisherFixture(html), finalUrl: url };
    } });
    const result = await resolve({ query: identity.name, countryHint: "" }, contextFixture());
    expect(inspected).toEqual(["https://example.edu/", "https://independent.example/directory"]);
    if (corroborated) {
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") throw new Error("Missing original-source identity");
      expect(result.university.officialDomains).toEqual(["example.edu"]);
      expect(result.university.sources.map((item) => item.url)).toEqual(["https://independent.example/directory", "https://example.edu/"]);
      expect(result.university.sources.every((item) => item.policy.retention === "transient_only")).toBe(true);
    } else expect(result.kind).not.toBe("resolved");
  });
  it("bounds missing-Wikidata publisher inspection and does not promote ranked search URLs", async () => {
    const inspected: string[] = [];
    const resolve = createResolver({ lookup: async () => [],
      search: async () => Array.from({ length: 20 }, (_, index) => ({ pageUrl: `https://result${index}.example/`, policy: transientPolicy })),
      fetchPage: async (url) => { inspected.push(url); return { ...publisherFixture("<h1>Example University</h1>"), finalUrl: url }; } });
    expect((await resolve({ query: identity.name, countryHint: "" }, contextFixture())).kind).not.toBe("resolved");
    expect(inspected).toHaveLength(5);
  });
  it.each(["sibling", "no-visible-evidence", "no-official-link", "conflicting-location"])("withholds unsupported publisher corroboration: %s", async (condition) => {
    const primaryUrl = "https://www.example.edu/";
    const corroboratingUrl = condition === "sibling" ? "https://news.example.edu/directory" : "https://independent.example/directory";
    const data = (city: string) => JSON.stringify({ "@type": "CollegeOrUniversity", name: identity.name, url: primaryUrl,
      address: { addressLocality: city, addressCountry: identity.country } });
    const urls = [primaryUrl, corroboratingUrl, ...(condition === "conflicting-location" ? ["https://another.example/directory"] : [])];
    const resolve = createResolver({ lookup: async () => [], search: async () => urls.map((pageUrl) => ({ pageUrl, policy: transientPolicy })),
      fetchPage: async (url) => {
        const primary = url === primaryUrl;
        const city = url.includes("another.example") ? "Different City" : identity.city;
        const content = primary ? official.replaceAll("example.edu", "www.example.edu") : `<h1>Example University</h1>
          ${condition === "no-visible-evidence" ? "" : `<p>${city}, Example Country</p>`}
          ${condition === "no-official-link" ? "" : `<a href="${primaryUrl}">Official website</a>`}`;
        return { ...publisherFixture(`${content}<script type="application/ld+json">${data(city)}</script>`), finalUrl: url };
      } });
    expect((await resolve({ query: identity.name, countryHint: "" }, contextFixture())).kind).not.toBe("resolved");
  });
});
