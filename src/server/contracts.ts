export interface RunContext {
  readonly requestId: string;
  readonly sessionId: string;
  readonly ipHash: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadlineAt: number;
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
export interface Evidence {
  source: SourceRef; imageId: string; imageUrl: string;
  excerpt: string; association: "explicit" | "gallery" | "mention" | "none";
  authority: "official" | "attributable" | "unknown";
  locationSupported: boolean; categorySupported: boolean;
  officialDirect: boolean; independentEquivalent: boolean;
  corroboration: 20 | 10 | 0; corroborationEvidenceIds: string[];
  conflict: boolean; forbidden: boolean;
}
export interface Candidate {
  id: string; imageUrl: string; pageUrl: string; evidence: Evidence[];
  categoryHint?: Category; policy: UsagePolicy;
}
export interface FetchResult {
  finalUrl: string; contentType: string; bytes: Uint8Array;
  retrievedAt: string; status: number;
}
