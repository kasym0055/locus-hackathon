import { z } from "zod";
import type { Assessment, AssessmentInput } from "@/server/contracts";

export const internalId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const boundedText = z.string().max(240);
export const assessmentSchema = z.strictObject({ assessments: z.array(z.strictObject({
  imageId: internalId, assessed: z.boolean(),
  category: z.enum(["campus", "dormitory", "classrooms", "library", "laboratories", "sport", "student_life", "city"]).nullable(),
  visual: z.union([z.literal(0), z.literal(5), z.literal(10)]),
  safety: z.enum(["clear", "unsafe", "uncertain"]), relevance: z.enum(["relevant", "irrelevant", "uncertain"]),
  authenticity: z.enum(["photo", "stock", "render", "uncertain"]), location: z.enum(["supported", "conflict", "uncertain"]),
  evidenceIds: z.array(internalId).max(48), observations: z.array(boundedText).max(4), uncertainties: z.array(boundedText).max(4),
})).max(16) });
export const assessmentJsonSchema = z.toJSONSchema(assessmentSchema);
const urlPattern = /(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|file):|\bwww\.|(?:^|\s)\/\/)/i;
export function parseAssessments(text: string, input: AssessmentInput): Assessment[] {
  const { assessments } = assessmentSchema.parse(JSON.parse(text));
  const ids = new Set(assessments.map(({ imageId }) => imageId));
  if (assessments.length !== input.images.length || ids.size !== assessments.length
    || input.images.some(({ id }) => !ids.has(id))) throw new Error("invalid image IDs");
  for (const assessment of assessments) {
    const allowed = new Set(input.evidence.filter(({ imageId }) => imageId === assessment.imageId).map(({ id }) => id));
    if (new Set(assessment.evidenceIds).size !== assessment.evidenceIds.length
      || assessment.evidenceIds.some((id) => !allowed.has(id))
      || [...assessment.observations, ...assessment.uncertainties].some((text) => urlPattern.test(text))) throw new Error("invalid evidence or URL");
  }
  return assessments;
}
