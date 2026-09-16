import type { Assessment, Decision, Evidence } from "@/server/contracts";
function origin(url: string): string | undefined {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : undefined; }
  catch { return undefined; }
}
const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
export function decide(input: { resolved: boolean; usable: boolean; evidence: Evidence; assessment: Assessment }): Decision {
  const { evidence, assessment } = input;
  const stop = (status: "withheld" | "rejected", reason: string): Decision => ({ status, score: 0,
    components: { authority: 0, attribution: 0, corroboration: 0, visual: 0 }, reasons: [reason] });
  if (evidence.conflict || assessment.location === "conflict") return stop("rejected", "confirmed_location_conflict");
  if (assessment.safety === "unsafe") return stop("rejected", "unsafe");
  if (["stock", "render"].includes(assessment.authenticity)) return stop("rejected", assessment.authenticity);
  if (assessment.relevance === "irrelevant") return stop("rejected", "irrelevant");
  if (evidence.forbidden || evidence.source.policy.display === "disallowed" || evidence.source.policy.retention === "disallowed") return stop("rejected", "forbidden");
  if (assessment.safety !== "clear") return stop("withheld", "unresolved_safety");
  if (assessment.relevance !== "relevant") return stop("withheld", "unresolved_relevance");
  if (!assessment.assessed || assessment.imageId !== evidence.imageId) return stop("withheld", "unassessed_image");

  const supports = (evidence.corroborationSources ?? []).filter((support) =>
    support.source.id !== evidence.source.id && support.imageId === evidence.imageId && support.locationSupported
    && support.independent && origin(support.source.url) && origin(support.source.url) !== origin(evidence.source.url)
    && normalized(support.excerpt) && normalized(support.excerpt) !== normalized(evidence.excerpt)
    && support.source.policy.retention !== "disallowed"
    && (evidence.corroboration !== 10 || (support.visibleIdentifier && normalized(support.visibleIdentifier)
      && normalized(support.excerpt).includes(normalized(support.visibleIdentifier))
      && !normalized(evidence.excerpt).includes(normalized(support.visibleIdentifier))
      && assessment.observations.some((text) => normalized(text).includes(normalized(support.visibleIdentifier!))))));
  const allowedIds = new Set([evidence.source.id, ...supports.map(({ source }) => source.id)]);
  if (!assessment.evidenceIds.length || new Set(assessment.evidenceIds).size !== assessment.evidenceIds.length
    || assessment.evidenceIds.some((id) => !allowedIds.has(id))) return stop("withheld", "invalid_evidence_reference");
  const corroborationIds = evidence.corroborationEvidenceIds;
  const corroboration = corroborationIds.length && new Set(corroborationIds).size === corroborationIds.length
    && corroborationIds.every((id) => supports.some(({ source }) => source.id === id)) ? evidence.corroboration : 0;
  const components = {
    authority: origin(evidence.source.url) ? { official: 25, attributable: 15, unknown: 0 }[evidence.authority] : 0,
    attribution: evidence.excerpt.trim() ? { explicit: 45, gallery: 25, mention: 10, none: 0 }[evidence.association] : 0,
    corroboration,
    visual: assessment.observations.some((text) => text.trim()) ? assessment.visual : 0,
  };
  const gates = {
    resolved_identity: input.resolved,
    usable_media_and_source: input.usable && !!origin(evidence.source.url),
    permitted_display: evidence.source.policy.display === "direct_permitted",
    supported_location: evidence.locationSupported && !(evidence.locationScope === "city" && assessment.category !== "city"),
    supported_category: evidence.categorySupported && assessment.category !== null,
    clear_location: assessment.location === "supported" && assessment.authenticity === "photo",
    direct_or_independent_provenance: (evidence.officialDirect && evidence.authority === "official" && evidence.association === "explicit")
      || (evidence.independentEquivalent && evidence.authority !== "unknown" && evidence.association === "explicit" && corroboration === 20),
  };
  const reasons = Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => `missing_${gate}`);
  if (evidence.corroboration && !corroboration) reasons.push("unsupported_corroboration");
  const raw = Object.values(components).reduce((sum, value) => sum + value, 0);
  const score = Object.values(gates).every(Boolean) ? raw : Math.min(raw, 79);
  const status = score >= 80 ? "verified" : score >= 60 ? "uncertain" : "withheld";
  reasons.push(status === "verified" ? "all_verification_gates_passed" : "insufficient_evidence_score");
  return { status, score, components, reasons };
}
