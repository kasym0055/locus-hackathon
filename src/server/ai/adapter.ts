import { z } from "zod";
import type { AssessmentInput, FailureCode, RunContext } from "@/server/contracts";
import { validateImage } from "@/server/images/prepare";
import { internalId } from "./assessment-schema";

export class AiFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "AiFailure"; }
}
export function assertActive(ctx: RunContext) {
  if (ctx.signal.aborted) throw new AiFailure("cancelled");
  if (Date.now() >= ctx.deadlineAt) throw new AiFailure("deadline");
}
const evidenceSchema = z.array(z.strictObject({ id: internalId, imageId: internalId, excerpt: z.string().min(1).max(1200) })).max(48);
const discoverySchema = z.array(z.strictObject({ evidenceId: internalId, imageId: internalId, excerpt: z.string().min(1).max(600) })).max(16);
const redactLinks = (value: string) => value.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:data|javascript|file):|(?<!:)\/\/)[^\s<>"']+/gi, "[link omitted]");
const identityText = z.string().trim().min(1).max(200).refine(value => !/(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|file):|\bwww\.)/i.test(value));
const selectedUniversitySchema = z.strictObject({ name: identityText, campus: identityText, city: identityText, country: identityText });
const imageKeys = new Set(["id", "bytes", "mediaType", "width", "height", "byteLength", "originalSha256", "sha256"]);
export async function validateInput(input: AssessmentInput): Promise<AssessmentInput> {
  try {
    if (!input || Object.keys(input).some((key) => !["images", "evidence", "selectedUniversity", "discoveryContext"].includes(key)) || !Array.isArray(input.images)
      || !input.images.length || input.images.length > 16) throw new Error();
    const evidence = evidenceSchema.parse(input.evidence);
    const discoveryContext = input.discoveryContext === undefined ? undefined : discoverySchema.parse(input.discoveryContext);
    if (discoveryContext?.some(hint => !evidence.some(item => item.id === hint.evidenceId && item.imageId === hint.imageId))) throw new Error();
    const selectedUniversity = input.selectedUniversity === undefined ? undefined : selectedUniversitySchema.parse(input.selectedUniversity);
    const ids = new Set(input.images.map((image) => image?.id));
    if (ids.size !== input.images.length || new Set(evidence.map(({ id }) => id)).size !== evidence.length
      || evidence.some(({ imageId }) => !ids.has(imageId))) throw new Error();
    // Copy before async work so a caller cannot swap bytes after validation.
    const images = input.images.map((image) => {
      if (!image || typeof image !== "object" || Object.keys(image).some((key) => !imageKeys.has(key))
        || !(image.bytes instanceof Uint8Array) || image.bytes.length > 512 * 1024) throw new Error();
      return { ...image, bytes: Buffer.from(image.bytes) };
    });
    for (const image of images) await validateImage(image);
    return { images, ...(selectedUniversity ? { selectedUniversity } : {}),
      ...(discoveryContext ? { discoveryContext: discoveryContext.map(item => ({ ...item, excerpt: redactLinks(item.excerpt) })) } : {}),
      evidence: evidence.map(item => ({ ...item, excerpt: redactLinks(item.excerpt) })) };
  } catch { throw new AiFailure("invalid_request"); }
}
