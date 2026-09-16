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

function wikimediaFile($: CheerioAPI, pageUrl: string): { imageUrls: string[]; description: string; author: string;
  licenseText: string; licenseUrl: string; valid: boolean } | undefined {
  const page = new URL(pageUrl);
  if (page.origin !== "https://commons.wikimedia.org" || !/^\/wiki\/File(?::|%3A)/i.test(page.pathname)) return;
  const cleanWikimediaUrl = (value: string | undefined) => {
    if (!value) return;
    const resolved = resolveImage(value, pageUrl);
    if (!resolved) return;
    const url = new URL(resolved);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
    return url.href;
  };
  const original = cleanWikimediaUrl($(".fullMedia a.internal").first().attr("href"));
  if (!original || new URL(original).origin !== "https://upload.wikimedia.org") return;
  const description = compact($("#fileinfotpl_desc").first().parent().children("td").last().text());
  const author = compact($("#fileinfotpl_aut").first().parent().children("td").last().text());
  const licenseText = compact($(".licensetpl_short").first().text());
  const licenseUrl = compact($(".licensetpl_link").first().text());
  let validLicense = false;
  try {
    const license = new URL(licenseUrl);
    validLicense = license.protocol === "https:" && license.hostname === "creativecommons.org"
      && (/^\/licenses\//.test(license.pathname) || /^\/publicdomain\//.test(license.pathname));
  } catch { /* invalid or missing file-level license */ }
  const variants = images($, pageUrl).flatMap(({ urls }) => urls).map(cleanWikimediaUrl).filter((url): url is string => Boolean(url))
    .filter((url) => ["https://upload.wikimedia.org", "https://thumb.wikimedia.org"].includes(new URL(url).origin));
  return { imageUrls: [...new Set([original, ...variants])], description, author, licenseText, licenseUrl,
    valid: Boolean(description && description.length <= 2_000 && author && author.length <= 300
      && licenseText && licenseText.length <= 160 && validLicense) };
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
  const wikimedia = wikimediaFile($, page.finalUrl);
  // Access and public availability grant no image display/storage license.
  // The optional grant is supplied by trusted server policy configuration, never
  // inferred from article prose or the fact that an image has a public URL.
  const applicable = documentedPublisherPolicy?.origin === origin
    && documentedPublisherPolicy.basis.some((basis) => basis.trim())
    && (!documentedPublisherPolicy.expiresAt || Date.parse(documentedPublisherPolicy.expiresAt) > Date.now())
    && (!wikimedia || wikimedia.valid);
  const documented = applicable ? { ...documentedPublisherPolicy,
    ...(wikimedia?.valid ? { attributionText: `${wikimedia.author} — ${wikimedia.licenseText}`, licenseUrl: wikimedia.licenseUrl,
      basis: [...documentedPublisherPolicy.basis, `File license: ${wikimedia.licenseUrl}`] } : {}) }
    : { retention: "transient_only" as const, display: "link_only" as const, origin,
      policyVersion: "v1", basis: ["Publisher display and storage permissions not established"] };
  const merged = mergePolicy(inherited, documented);
  // A discovery record's link-only default means it supplied no display grant.
  // After following the original page, only a documented publisher grant may
  // establish display; provider-derived retention and any disallow still win.
  const policy = { ...merged, display: inherited.display === "disallowed" || documented.display === "disallowed"
    ? "disallowed" as const : documented.display };
  const hostname = new URL(page.finalUrl).hostname.toLowerCase();
  const official = university.officialDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`));
  const candidates = new Map<string, Candidate>();
  const discovered = [...images($, page.finalUrl).flatMap(({ urls }) => urls), ...(wikimedia?.imageUrls ?? [])];
  for (const imageUrl of [...new Set(discovered)]) {
      if (candidates.has(imageUrl)) continue;
      const bound = wikimedia?.imageUrls.includes(imageUrl) && wikimedia.valid
        ? completeBinding(wikimedia.description, "explicit") : bind($, imageUrl, page.finalUrl);
      const imageId = id(imageUrl);
      candidates.set(imageUrl, { id: imageId, imageUrl, pageUrl: page.finalUrl, policy,
        evidence: [{ source: { id: id(page.finalUrl), url: page.finalUrl, retrievedAt: page.retrievedAt, policy },
          imageId, imageUrl, excerpt: [bound.excerpt, articleText].filter(Boolean).join("\n\n"), association: bound.association,
          authority: official ? "official" : wikimedia?.valid && wikimedia.imageUrls.includes(imageUrl) ? "attributable" : "unknown", locationSupported: false, categorySupported: false,
          officialDirect: false, independentEquivalent: false, corroboration: 0, corroborationEvidenceIds: [],
          conflict: false, forbidden: policy.retention === "disallowed" || policy.display === "disallowed" }] });
      if (candidates.size === 40) return [...candidates.values()];
  }
  return [...candidates.values()];
}
