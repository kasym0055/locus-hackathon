import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Candidate, FailureCode, PreparedCandidate, RunContext, ValidatedImage } from "@/server/contracts";
import { safeFetch } from "@/server/fetch/safe-fetch";
export class ImageFailure extends Error {
  constructor(readonly code: FailureCode = "invalid_media") { super(code); this.name = "ImageFailure"; }
}
export const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function active(ctx: RunContext) {
  if (ctx.signal.aborted) throw new ImageFailure("cancelled");
  if (Date.now() >= ctx.deadlineAt) throw new ImageFailure("deadline");
}
function magic(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "webp";
}
async function metadata(bytes: Uint8Array, contentType: string) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 5_000_000) throw new ImageFailure();
  const format = magic(bytes);
  if (!format || contentType.split(";")[0].trim().toLowerCase() !== `image/${format}`) throw new ImageFailure();
  if (format === "png") {
    // libvips can decode only the default PNG frame and omit APNG page metadata.
    // Inspect actual chunks, never a substring that could occur inside pixel data.
    const png = Buffer.from(bytes);
    for (let offset = 8; offset < png.length;) {
      if (offset + 12 > png.length) throw new ImageFailure();
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > png.length || ["acTL", "fcTL", "fdAT"].includes(type)) throw new ImageFailure();
      offset += length + 12;
      if (type === "IEND") break;
    }
  }
  if (format === "jpeg") {
    const jpeg = Buffer.from(bytes);
    // MPO/MPF can also look like a valid single JPEG to the raster decoder.
    for (let offset = 2; offset < jpeg.length;) {
      if (jpeg[offset] !== 0xff || offset + 1 >= jpeg.length) throw new ImageFailure();
      const marker = jpeg[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (offset + 4 > jpeg.length) throw new ImageFailure();
      const length = jpeg.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > jpeg.length) throw new ImageFailure();
      if (marker === 0xe2 && jpeg.toString("ascii", offset + 4, offset + 8) === "MPF\0") throw new ImageFailure();
      offset += length + 2;
    }
  }
  const meta = await sharp(bytes, { limitInputPixels: 20_000_000, failOn: "warning", animated: true }).metadata();
  if (meta.format !== format || !meta.width || !meta.height || (meta.pages ?? 1) !== 1
    || meta.width * meta.height > 20_000_000 || Math.min(meta.width, meta.height) < 160 || meta.width * meta.height < 60_000) throw new ImageFailure();
  return meta;
}

// Recheck at the provider boundary; a TypeScript type cannot attest runtime bytes.
export async function validateImage(image: ValidatedImage): Promise<void> {
  try {
    if (!image || typeof image !== "object" || !/^[a-zA-Z0-9_-]{1,80}$/.test(image.id)
      || !(image.bytes instanceof Uint8Array) || image.bytes.length > 512 * 1024
      || image.byteLength !== image.bytes.length || image.mediaType !== "image/jpeg"
      || !/^[a-f0-9]{64}$/.test(image.originalSha256) || hashBytes(image.bytes) !== image.sha256) throw new ImageFailure();
    const meta = await metadata(image.bytes, image.mediaType);
    if (meta.width !== image.width || meta.height !== image.height || Math.max(image.width, image.height) > 1024 || meta.exif || meta.icc || meta.xmp) throw new ImageFailure();
    await sharp(image.bytes, { limitInputPixels: 20_000_000, failOn: "warning" }).raw().toBuffer();
  } catch { throw new ImageFailure(); }
}
export function createImagePreparer(fetcher = safeFetch) {
  return async (candidate: Candidate, ctx: RunContext): Promise<PreparedCandidate> => {
    active(ctx);
    if (candidate.policy.retention === "disallowed" || candidate.policy.display === "disallowed") throw new ImageFailure("access_denied");
    const result = await fetcher(candidate.imageUrl, "image", ctx);
    active(ctx);
    try {
      await metadata(result.bytes, result.contentType);
      const originalSha256 = hashBytes(result.bytes);
      for (const quality of [80, 65, 50]) {
        active(ctx);
        const { data, info } = await sharp(result.bytes, { limitInputPixels: 20_000_000, failOn: "warning" })
          .rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "white" }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
        active(ctx);
        if (data.length <= 512 * 1024) return { candidate, image: { id: candidate.id, bytes: data, mediaType: "image/jpeg",
          width: info.width, height: info.height, byteLength: data.length, originalSha256, sha256: hashBytes(data) } };
      }
      throw new ImageFailure();
    } catch (error) {
      if (error instanceof ImageFailure) throw error;
      throw new ImageFailure();
    }
  };
}
export const prepareImage = createImagePreparer();
