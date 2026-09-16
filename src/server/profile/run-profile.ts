import type { Emit } from "@/lib/events";
import type { Evidence, FailureCode, ImageCardData, ProfileQuery, RunContext, University, Assessment } from "@/server/contracts";
import { failureSchema } from "@/lib/event-schema";
import { decide } from "@/server/policy/decide";
import { assembleProfile } from "./assemble";
import { productionServices, type ProfileServices } from "./services";
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function support(evidence: Evidence, university: University, assessment: Assessment): Evidence {
  // Only the image-bound caption, never unrelated article text, establishes location.
  const caption = normalized(evidence.excerpt.split("\n\n")[0]);
  const name = [university.name, ...university.aliases].some(value => caption.includes(normalized(value)));
  const location = caption.includes(normalized(university.city)) && caption.includes(normalized(university.campus));
  const category = assessment.category === "campus" && /\b(campus|courtyard)\b|кампус/iu.test(caption);
  const direct = evidence.authority === "official" && evidence.association === "explicit";
  return { ...evidence, locationSupported: direct && name && location, locationScope: "campus", categorySupported: direct && category,
    officialDirect: direct && name && location };
}
export function failureCode(error: unknown, ctx?: RunContext): FailureCode {
  if (ctx && Date.now() >= ctx.deadlineAt) return "deadline";
  if (ctx?.signal.aborted) return "cancelled";
  const parsed = failureSchema.safeParse((error as { code?: unknown })?.code);
  return parsed.success ? parsed.data : "dependency_unavailable";
}
export function createProfileRunner(services: ProfileServices) {
  return async (query: ProfileQuery, ctx: RunContext, emit: Emit, admitted = false): Promise<void> => {
    let lease = admitted, university: University | undefined;
    const cards: ImageCardData[] = [], warnings: FailureCode[] = [];
    const elapsedMs = () => Math.max(0, Date.now() - ctx.startedAt);
    const active = () => { if (ctx.signal.aborted || Date.now() >= ctx.deadlineAt) throw { code: failureCode(null, ctx) }; };
    const final = () => {
      if (!university) { emit({ type: "final", data: { state: "unavailable", profile: null, elapsedMs: elapsedMs() } }); return; }
      const profile = assembleProfile({ university, cards, description: [], sources: [...university.sources, ...cards.map(card => card.source)], warnings, elapsedMs: elapsedMs() });
      emit({ type: "final", data: { state: profile.state, profile, elapsedMs: profile.elapsedMs } });
    };
    try {
      active();
      if (!lease) {
        const admission = await services.ledger.admit(ctx); lease = admission.allowed;
        if (!lease) { emit({ type: "fatal", data: { code: "busy", message: "Please try again shortly.", retryAfterSeconds: admission.retryAfterSeconds } }); return; }
      }
      active(); emit({ type: "stage", data: { stage: "resolving" } });
      const resolution = await services.resolve(query, ctx); active();
      if (resolution.kind === "needs_selection") {
        emit({ type: "clarification", data: { choices: resolution.choices } });
        emit({ type: "final", data: { state: "needs_selection", profile: null, elapsedMs: elapsedMs() } }); return;
      }
      if (resolution.kind === "not_found") { emit({ type: "final", data: { state: "not_found", profile: null, elapsedMs: elapsedMs() } }); return; }
      if (resolution.kind === "unavailable") throw { code: resolution.code };
      university = resolution.university; emit({ type: "identity", data: { university } });
      emit({ type: "stage", data: { stage: "discovering" } });
      const candidates = await services.discover(university, ["campus"], ctx); active();
      const candidate = candidates[0];
      if (candidate && candidate.policy.display === "direct_permitted" && candidate.policy.retention !== "disallowed") {
        emit({ type: "stage", data: { stage: "preparing" } });
        const prepared = await services.prepare(candidate, ctx); active();
        emit({ type: "stage", data: { stage: "assessing" } });
        await services.ledger.check(ctx); active();
        const result = await services.ai.assess({ images: [prepared.image], evidence: candidate.evidence.map(e => ({ id: e.source.id, imageId: e.imageId, excerpt: e.excerpt.slice(0, 1200) })) }, ctx);
        active();
        if (!result.ok) throw { code: result.code };
        const assessment = result.assessments.find(item => item.imageId === candidate.id);
        if (assessment) {
          for (const evidence of candidate.evidence) {
            const decision = decide({ resolved: true, usable: true, evidence: support(evidence, university, assessment), assessment });
            if (decision.status === "verified" && assessment.category) {
              const card: ImageCardData = { id: candidate.id, revision: 1, category: assessment.category, tags: [], status: decision.status, score: decision.score,
                components: decision.components, reasons: decision.reasons, source: evidence.source, displayUrl: candidate.imageUrl, delivery: "remote" };
              cards.push(card); emit({ type: "image", data: { card } }); break;
            }
          }
        }
      } else if (candidate) warnings.push("policy_unknown");
      active(); emit({ type: "stage", data: { stage: "assembling" } }); final();
    } catch (error) {
      const code = failureCode(error, ctx); warnings.push(code);
      emit({ type: "warning", data: { code, message: code === "deadline" ? "The request reached its time limit." : "Some evidence could not be retrieved or verified." } }); final();
    } finally { if (lease) await services.ledger.release(ctx.requestId).catch(() => {}); }
  };
}
export async function runProfile(query: ProfileQuery, ctx: RunContext, emit: Emit): Promise<void> {
  try { await createProfileRunner(await productionServices())(query, ctx, emit); }
  catch { emit({ type: "final", data: { state: "unavailable", profile: null, elapsedMs: Math.max(0, Date.now() - ctx.startedAt) } }); }
}
