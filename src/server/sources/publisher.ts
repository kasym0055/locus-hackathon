import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { Candidate, Evidence, FetchResult, University, UsagePolicy } from "@/server/contracts";
import { mergePolicy } from "./usage-policy";

const imageAttributes = ["src", "data-src", "data-original", "data-lazy-src", "data-url"];
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const id = (value: string) => createHash("sha256").update(value).digest("hex");

function completeBinding(excerpt: string, association: Evidence["association"]): { excerpt: string; association: Evidence["association"] } {
  // A truncated caption can hide contradictory prose. Keep the complete bounded
  // binding or discard its association, never fall back to a shorter prefix.
  return excerpt.length <= 2_000 ? { excerpt, association } : { excerpt: "", association: "none" };
}

function resolveImage(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return;
    url.hash = "";
    return url.href;
  } catch { return; }
}

function images($: CheerioAPI, base: string) {
  return $("img").toArray().map((element) => {
    const image = $(element);
    const values = imageAttributes.flatMap((name) => image.attr(name) ? [image.attr(name)!] : []);
    const sets = [image.attr("srcset"), image.attr("data-srcset")];
    image.closest("picture").find("source").each((_, source) => {
      sets.push($(source).attr("srcset"), $(source).attr("data-srcset"));
    });
    for (const set of sets) {
      for (const part of (set ?? "").split(",")) {
        const value = part.trim().split(/\s+/)[0];
        if (value) values.push(value);
      }
    }
    return { image, urls: [...new Set(values.map((value) => resolveImage(value, base)).filter((url): url is string => Boolean(url)))] };
  });
}

function bind($: CheerioAPI, imageUrl: string, base: string): { excerpt: string; association: Evidence["association"] } {
  for (const { image, urls } of images($, base)) {
    if (!urls.includes(imageUrl) || image.closest("footer, header, nav").length) continue;
    const figure = image.closest("figure");
    const caption = compact(figure.children("figcaption").text());
    if (figure.find("img").length === 1 && caption) return completeBinding(caption, "explicit");
    const item = image.closest('.gallery-item, [data-gallery-item], [itemtype$="/ImageObject"]');
    const galleryCaption = compact(item.find('.caption, [itemprop="caption"]').text());
    if (item.find("img").length === 1 && galleryCaption) return completeBinding(galleryCaption, "gallery");
    const metadata = compact(image.attr("data-caption") || image.attr("alt") || image.attr("title") || "");
    if (metadata) return completeBinding(metadata, "explicit");
  }
  return { excerpt: "", association: "none" };
}

export function bindEvidence(html: string, imageUrl: string): { excerpt: string; association: Evidence["association"] } {
  return bind(load(html), imageUrl, imageUrl);
}

export function extractCandidates(page: FetchResult, university: University, inherited: UsagePolicy, documentedPublisherPolicy?: UsagePolicy): Candidate[] {
  if (page.status < 200 || page.status >= 300 || !["text/html", "application/xhtml+xml"].includes(page.contentType.split(";")[0].trim())) return [];
  const $ = load(new TextDecoder().decode(page.bytes));
  $("script, style, template, noscript").remove();
  const article = $("article, main").first();
  const context = (article.length ? article : $("body")).clone();
  context.find("header, footer, nav").remove();
  const articleText = compact(context.text()).slice(0, 12_000);
  const origin = new URL(page.finalUrl).origin;
  // Access and public availability grant no image display/storage license.
  // The optional grant is supplied by trusted server policy configuration, never
  // inferred from article prose or the fact that an image has a public URL.
  const applicable = documentedPublisherPolicy?.origin === origin
    && documentedPublisherPolicy.basis.some((basis) => basis.trim())
    && (!documentedPublisherPolicy.expiresAt || Date.parse(documentedPublisherPolicy.expiresAt) > Date.now());
  const policy = mergePolicy(inherited, applicable ? documentedPublisherPolicy : { retention: "transient_only", display: "link_only", origin,
    policyVersion: "v1", basis: ["Publisher display and storage permissions not established"] });
  const hostname = new URL(page.finalUrl).hostname.toLowerCase();
  const official = university.officialDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`));
  const candidates = new Map<string, Candidate>();
  for (const { urls } of images($, page.finalUrl)) {
    for (const imageUrl of urls) {
      if (candidates.has(imageUrl)) continue;
      const bound = bind($, imageUrl, page.finalUrl);
      const imageId = id(imageUrl);
      candidates.set(imageUrl, { id: imageId, imageUrl, pageUrl: page.finalUrl, policy,
        evidence: [{ source: { id: id(page.finalUrl), url: page.finalUrl, retrievedAt: page.retrievedAt, policy },
          imageId, imageUrl, excerpt: [bound.excerpt, articleText].filter(Boolean).join("\n\n"), association: bound.association,
          authority: official ? "official" : "unknown", locationSupported: false, categorySupported: false,
          officialDirect: false, independentEquivalent: false, corroboration: 0, corroborationEvidenceIds: [],
          conflict: false, forbidden: policy.retention === "disallowed" || policy.display === "disallowed" }] });
      if (candidates.size === 40) return [...candidates.values()];
    }
  }
  return [...candidates.values()];
}
