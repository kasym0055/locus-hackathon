import { describe, expect, it } from "vitest";
import { normalizeQuery, createResolver } from "@/server/discovery/resolver";
import { contextFixture, publisherFixture } from "../support/fixtures";

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
});
