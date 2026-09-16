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
const imageKeys = new Set(["id", "bytes", "mediaType", "width", "height", "byteLength", "originalSha256", "sha256"]);
export async function validateInput(input: AssessmentInput): Promise<AssessmentInput> {
  try {
    if (!input || Object.keys(input).some((key) => !["images", "evidence"].includes(key)) || !Array.isArray(input.images)
      || !input.images.length || input.images.length > 16) throw new Error();
    const evidence = evidenceSchema.parse(input.evidence);
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
    return { images, evidence: evidence.map((item) => ({ ...item,
      excerpt: item.excerpt.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:data|javascript|file):|(?<!:)\/\/)[^\s<>"']+/gi, "[link omitted]") })) };
  } catch { throw new AiFailure("invalid_request"); }
}
