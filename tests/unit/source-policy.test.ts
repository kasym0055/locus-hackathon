import { describe, expect, it } from "vitest";
import { bindEvidence, extractCandidates } from "@/server/sources/publisher";
import { mergePolicy } from "@/server/sources/usage-policy";
import { publisherFixture, transientPolicy, universityFixture } from "../support/fixtures";

describe("exact-image publisher evidence", () => {
  it.each(["figure", "gallery", "data-caption", "alt", "title"])("rejects oversized %s evidence rather than binding a truncated prefix", kind => {
    const caption = "x".repeat(2000) + " This is actually another campus.";
    const html = kind === "figure" ? `<figure><img src="/x.jpg" alt="Short fallback"><figcaption>${caption}</figcaption></figure>`
      : kind === "gallery" ? `<div class="gallery-item"><img src="/x.jpg" alt="Short fallback"><p class="caption">${caption}</p></div>`
      : `<img src="/x.jpg" ${kind}="${caption}">`;
    expect(bindEvidence(html, "https://example.edu/x.jpg")).toEqual({ excerpt: "", association: "none" });
  });
  it("retains the full image-bound caption at the exact evidence limit", () => {
    const caption = "x".repeat(2000);
    expect(bindEvidence(`<figure><img src="/x.jpg"><figcaption>${caption}</figcaption></figure>`, "https://example.edu/x.jpg"))
      .toEqual({ excerpt: caption, association: "explicit" });
  });
  it("does not treat a university footer as photo attribution", () => {
    const result = bindEvidence('<img src="/x.jpg"><footer>Example University</footer>', "https://example.edu/x.jpg");
    expect(result.association).toBe("none");
  });
  it("binds a figure caption only to its own image", () => {
    const html = '<figure><img src="/x.jpg"><figcaption>Library photo by Ada</figcaption></figure><img src="/y.jpg">';
    expect(bindEvidence(html, "https://example.edu/x.jpg")).toEqual({ excerpt: "Library photo by Ada", association: "explicit" });
    expect(bindEvidence(html, "https://example.edu/y.jpg").association).toBe("none");
  });
  it("does not attach ambiguous multi-image figure captions to every photo", () => {
    expect(bindEvidence('<figure><img src="/x.jpg"><img src="/y.jpg"><figcaption>Library</figcaption></figure>', "https://example.edu/x.jpg").association).toBe("none");
  });
  it("binds the same gallery item and explicit metadata but not neighboring items", () => {
    expect(bindEvidence('<div class="gallery-item"><img data-src="/x.jpg"><p class="caption">Library</p></div>', "https://example.edu/x.jpg").association).toBe("gallery");
    expect(bindEvidence('<img src="/x.jpg" alt="Library interior">', "https://example.edu/x.jpg")).toEqual({ excerpt: "Library interior", association: "explicit" });
    expect(bindEvidence('<div class="gallery-item"><img src="/x.jpg"></div><div class="gallery-item"><p class="caption">Library</p></div>', "https://example.edu/x.jpg").association).toBe("none");
  });
  it("resolves lazy/srcset URLs against the final URL and keeps contradictory article context", () => {
    const candidates = extractCandidates(publisherFixture(), universityFixture(), transientPolicy);
    expect(candidates.map((candidate) => candidate.imageUrl)).toContain("https://example.edu/photos/visit-large.jpg");
    expect(candidates.map((candidate) => candidate.imageUrl)).toContain("https://example.edu/photos/court.jpg");
    const visit = candidates.find((candidate) => candidate.imageUrl.endsWith("visit.jpg"))!;
    expect(visit.evidence[0].association).toBe("explicit");
    expect(visit.evidence[0].excerpt).toContain("not Example University");
    expect(visit.evidence[0].officialDirect).toBe(false);
    expect(visit.evidence[0].locationSupported).toBe(false);
    expect(visit.policy.retention).toBe("transient_only");
    expect(visit.policy.display).toBe("link_only");
  });
  it("never treats footer logos or an official hostname as verified attribution", () => {
    const candidate = extractCandidates(publisherFixture('<img src="/logo.svg"><footer>Example University</footer>'), universityFixture(), transientPolicy)[0];
    expect(candidate.evidence[0]).toMatchObject({ authority: "official", association: "none", officialDirect: false });
  });
  it("discards active/credential URLs and bounds candidate collection", () => {
    const html = '<img src="data:text/html,evil"><img src="https://user:pass@example.edu/x.jpg">' + Array.from({ length: 50 }, (_, index) => `<img src="/${index}.jpg">`).join("");
    const candidates = extractCandidates(publisherFixture(html), universityFixture(), transientPolicy);
    expect(candidates).toHaveLength(40);
    expect(candidates.every((candidate) => candidate.imageUrl.startsWith("https://example.edu/"))).toBe(true);
  });
  it("keeps documented publisher permission and author obligations while preserving discovery retention", () => {
    const inherited = { ...transientPolicy, display: "direct_permitted" as const };
    const publisher = { origin: "https://example.edu", policyVersion: "v1", basis: ["Synthetic explicit photo display and retention grant"],
      display: "direct_permitted" as const, retention: "cache_permitted" as const, attributionText: "Synthetic Author — synthetic license" };
    const candidate = extractCandidates(publisherFixture(), universityFixture(), inherited, publisher)[0];
    expect(candidate.policy).toMatchObject({ display: "direct_permitted", retention: "transient_only", attributionText: "Synthetic Author — synthetic license" });
    expect(candidate.policy.basis).toContain("Synthetic explicit photo display and retention grant");
  });
  it("does not apply an unrelated or undocumented publisher grant", () => {
    const inherited = { ...transientPolicy, display: "direct_permitted" as const };
    const publisher = { ...inherited, origin: "https://unrelated.org", retention: "cache_permitted" as const };
    expect(extractCandidates(publisherFixture(), universityFixture(), inherited, publisher)[0].policy.display).toBe("link_only");
    expect(extractCandidates(publisherFixture(), universityFixture(), inherited, { ...publisher, origin: "https://example.edu", basis: [] })[0].policy.display).toBe("link_only");
  });
  it("retains contradictory body context on pages without semantic article tags", () => {
    const page = publisherFixture('<div><p>These photographs show Partner University, not Example University.</p><figure><img src="/visit.jpg"><figcaption>Library visit</figcaption></figure></div><footer>Example University</footer>');
    expect(extractCandidates(page, universityFixture(), transientPolicy)[0].evidence[0].excerpt).toContain("not Example University");
  });
});
describe("derived usage policy", () => {
  it("preserves discovery restrictions after following the source", () => {
    const common = { origin: "test", policyVersion: "v1", basis: [], display: "link_only" as const };
    expect(mergePolicy({ ...common, retention: "transient_only" }, { ...common, retention: "cache_permitted" }).retention).toBe("transient_only");
  });
  it("computes display separately and preserves the earliest expiry and author obligations", () => {
    const result = mergePolicy({ ...transientPolicy, display: "direct_permitted", attributionText: "Ada", expiresAt: "2026-09-17T00:00:00Z" },
      { ...transientPolicy, retention: "cache_permitted", display: "direct_permitted", attributionText: "CC BY", expiresAt: "2026-09-18T00:00:00Z" });
    expect(result).toMatchObject({ retention: "transient_only", display: "direct_permitted", expiresAt: "2026-09-17T00:00:00Z", attributionText: "Ada; CC BY" });
    expect(mergePolicy(result, { ...transientPolicy, display: "disallowed", retention: "disallowed" })).toMatchObject({ retention: "disallowed", display: "disallowed" });
    expect(mergePolicy(result, transientPolicy).display).toBe("link_only");
  });
});
