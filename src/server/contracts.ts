export interface RunContext {
  readonly requestId: string;
  readonly sessionId: string;
  readonly ipHash: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadlineAt: number;
  // Internal diagnostics only; never supplied by a profile request body.
  publisherPhase?: "identity" | "official_discovery" | "licensed_category" | "licensed_file"
    | "official_corroboration" | "image_search" | "image_preparation";
}

export interface RunContextInput {
  requestId: string;
  sessionId: string;
  ipHash: string;
  signal: AbortSignal;
  now: number;
}

export type Category = "campus" | "dormitory" | "classrooms" | "library"
  | "laboratories" | "sport" | "student_life" | "city";
export type Retention = "transient_only" | "cache_permitted" | "disallowed";
export type FailureCode = "invalid_request" | "busy" | "budget_exhausted"
  | "dependency_unavailable" | "invalid_provider_output" | "deadline"
  | "cancelled" | "unsafe_target" | "access_denied" | "invalid_media"
  | "policy_unknown" | "protocol_error";
export interface UsagePolicy {
  retention: Retention; origin: string; policyVersion: string;
  basis: string[]; expiresAt?: string;
  display: "direct_permitted" | "link_only" | "disallowed";
  attributionText?: string;
  licenseUrl?: string;
}
export interface SourceRef {
  id: string; url: string; retrievedAt: string;
  publishedAt?: string; capturedAt?: string;
  dateBasis?: string; policy: UsagePolicy;
}
export interface University {
  id: string; name: string; aliases: string[]; campus: string;
  city: string; country: string; officialDomains: string[];
  sources: SourceRef[];
}
export interface ProfileQuery {
  query: string; countryHint: string; selectionToken?: string;
}
export type Resolution =
  | { kind: "resolved"; university: University }
  | { kind: "needs_selection"; choices: Array<{
      name: string; campus: string; city: string; country: string;
      officialDomain: string; source: SourceRef; selectionToken: string;
    }> }
  | { kind: "not_found" }
  | { kind: "unavailable"; code: FailureCode };
export interface Evidence {
  source: SourceRef; imageId: string; imageUrl: string;
  excerpt: string; association: "explicit" | "gallery" | "mention" | "none";
  authority: "official" | "attributable" | "unknown";
  locationSupported: boolean; categorySupported: boolean;
  officialDirect: boolean; independentEquivalent: boolean;
  corroboration: 20 | 10 | 0; corroborationEvidenceIds: string[];
  conflict: boolean; forbidden: boolean;
  locationScope?: "campus" | "city";
  corroborationSources?: Array<{
    source: SourceRef; imageId: string; excerpt: string;
    independent: boolean; locationSupported: boolean;
    visibleIdentifier?: string;
  }>;
}
export interface Candidate {
  id: string; imageUrl: string; pageUrl: string; evidence: Evidence[];
  categoryHint?: Category; policy: UsagePolicy;
}
export interface FetchResult {
  finalUrl: string; contentType: string; bytes: Uint8Array;
  retrievedAt: string; status: number;
  // Observed redirect destinations, in order; request-local transport metadata.
  redirectUrls?: string[];
}

// Bytes never enter persistent storage or a browser response. These are request-scoped.
export interface ValidatedImage {
  id: string; bytes: Uint8Array; mediaType: "image/jpeg";
  width: number; height: number; byteLength: number;
  originalSha256: string; sha256: string;
}
export interface PreparedCandidate { candidate: Candidate; image: ValidatedImage }
export interface Assessment {
  imageId: string; assessed: boolean; category: Category | null; visual: 10 | 5 | 0;
  safety: "clear" | "unsafe" | "uncertain";
  relevance: "relevant" | "irrelevant" | "uncertain";
  authenticity: "photo" | "stock" | "render" | "uncertain";
  location: "supported" | "conflict" | "uncertain";
  evidenceIds: string[]; observations: string[]; uncertainties: string[];
}
export interface Decision {
  status: "verified" | "uncertain" | "withheld" | "rejected";
  score: number; components: { authority: number; attribution: number; corroboration: number; visual: number };
  reasons: string[];
}
export interface AssessmentInput {
  images: ValidatedImage[];
  evidence: Array<{ id: string; imageId: string; excerpt: string }>;
  discoveryContext?: Array<{ evidenceId: string; imageId: string; excerpt: string }>;
  selectedUniversity?: Pick<University, "name" | "campus" | "city" | "country">;
}
export interface AiUsage { inputTokens: number; outputTokens: number; costMicrousd: number }
export type AssessmentResult = { ok: true; assessments: Assessment[]; provider: "openai"; model: string; usage: AiUsage }
  | { ok: false; code: FailureCode; provider: "openai"; model: string };
export interface AiAdapter {
  readonly capabilities: { imageInput: true; structuredOutput: true; cancellation: true; costAccounting: true };
  assess(input: AssessmentInput, ctx: RunContext): Promise<AssessmentResult>;
  describe(input: unknown, ctx: RunContext): Promise<{ ok: false; code: FailureCode }>;
}
export interface ImageCardData {
  id: string; revision: number; category: Category; tags: Category[];
  status: "verified" | "uncertain"; score: number; components: Decision["components"];
  reasons: string[]; source: SourceRef; displayUrl?: string;
  delivery: "remote" | "missing" | "not_permitted";
}
export interface Claim { text: string; evidenceIds: string[]; campusFact: boolean }
export interface Profile {
  university: University; cards: ImageCardData[]; description: Claim[]; sources: SourceRef[];
  gaps: Partial<Record<Category, string>>; state: "complete" | "partial" | "insufficient_evidence" | "unavailable";
  verifiedBaseCategories: number; warnings: FailureCode[]; provenance: "live" | "eligible_cache"; elapsedMs: number;
}
