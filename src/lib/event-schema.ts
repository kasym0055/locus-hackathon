import { z } from "zod";
export const categorySchema = z.enum(["campus", "dormitory", "classrooms", "library", "laboratories", "sport", "student_life", "city"]);
export const failureSchema = z.enum(["invalid_request", "busy", "budget_exhausted", "dependency_unavailable", "invalid_provider_output", "deadline", "cancelled", "unsafe_target", "access_denied", "invalid_media", "policy_unknown", "protocol_error"]);
export const urlSchema = z.string().max(4096).url().refine(value => {
  const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password;
});
const text = z.string().max(2000); const id = z.string().min(1).max(160);
export const policySchema = z.strictObject({ retention: z.enum(["transient_only", "cache_permitted", "disallowed"]), origin: text,
  policyVersion: text, basis: z.array(text).max(20), expiresAt: z.iso.datetime().optional(),
  display: z.enum(["direct_permitted", "link_only", "disallowed"]), attributionText: text.optional(), licenseUrl: urlSchema.optional() });
export const sourceSchema = z.strictObject({ id, url: urlSchema, retrievedAt: z.iso.datetime(), publishedAt: text.optional(), capturedAt: text.optional(), dateBasis: text.optional(), policy: policySchema });
const universitySchema = z.strictObject({ id, name: text, aliases: z.array(text).max(50), campus: text, city: text, country: text,
  officialDomains: z.array(z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)).max(10), sources: z.array(sourceSchema).max(20) });
const cardSchema = z.strictObject({ id, revision: z.number().int().positive(), category: categorySchema, tags: z.array(categorySchema).max(8), status: z.enum(["verified", "uncertain"]),
  score: z.number().int().min(0).max(100), components: z.strictObject({ authority: z.number().int().min(0).max(25), attribution: z.number().int().min(0).max(45), corroboration: z.number().int().min(0).max(20), visual: z.number().int().min(0).max(10) }),
  reasons: z.array(text).max(20), source: sourceSchema, displayUrl: urlSchema.optional(), delivery: z.enum(["remote", "missing", "not_permitted"]) }).refine(card =>
  card.delivery === "remote" ? !!card.displayUrl && card.source.policy.display === "direct_permitted" && card.source.policy.retention !== "disallowed" : !card.displayUrl);
const profileSchema = z.strictObject({ university: universitySchema, cards: z.array(cardSchema).max(24), description: z.array(z.strictObject({ text, evidenceIds: z.array(id).max(20), campusFact: z.boolean() })).max(20), sources: z.array(sourceSchema).max(50),
  gaps: z.partialRecord(categorySchema, text), state: z.enum(["complete", "partial", "insufficient_evidence", "unavailable"]), verifiedBaseCategories: z.number().int().min(0).max(7), warnings: z.array(failureSchema).max(20), provenance: z.enum(["live", "eligible_cache"]), elapsedMs: z.number().nonnegative() });
const envelope = { v: z.literal(1), requestId: z.uuid(), seq: z.number().int().positive() };
export const profileEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("stage"), data: z.strictObject({ stage: z.enum(["resolving", "discovering", "preparing", "assessing", "assembling"]) }) }),
  z.strictObject({ ...envelope, type: z.literal("identity"), data: z.strictObject({ university: universitySchema }) }),
  z.strictObject({ ...envelope, type: z.literal("clarification"), data: z.strictObject({ choices: z.array(z.strictObject({ name: text, campus: text, city: text, country: text, officialDomain: text, source: sourceSchema, selectionToken: z.string().max(8192) })).max(5) }) }),
  z.strictObject({ ...envelope, type: z.literal("image"), data: z.strictObject({ card: cardSchema }) }),
  z.strictObject({ ...envelope, type: z.literal("warning"), data: z.strictObject({ code: failureSchema, message: text, category: categorySchema.optional() }) }),
  z.strictObject({ ...envelope, type: z.literal("final"), data: z.strictObject({ state: z.enum(["complete", "partial", "insufficient_evidence", "unavailable", "needs_selection", "not_found"]), profile: profileSchema.nullable(), elapsedMs: z.number().nonnegative() }) }),
  z.strictObject({ ...envelope, type: z.literal("fatal"), data: z.strictObject({ code: failureSchema, message: text, retryAfterSeconds: z.number().int().nonnegative().optional() }) }),
]);
