import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createSafeFetcher } from "@/server/fetch/safe-fetch";
import { createImagePreparer } from "@/server/images/prepare";
import { contextFixture, decisionFixture, transportFixture } from "../support/fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function prepare(bytes: Uint8Array, mime: string) {
  const transport = await transportFixture((request, response) => {
    if (request.url === "/robots.txt") { response.setHeader("content-type", "text/plain"); response.end("User-agent: *\nAllow: /\n"); return; }
    response.setHeader("content-type", mime); response.end(bytes);
  });
  cleanups.push(transport.close);
  const fetcher = createSafeFetcher({ contactUrl: "https://project.example/contact", connect: transport.connector,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const evidence = decisionFixture({ authority: "official", association: "explicit", corroboration: 0, visual: 10 }).evidence;
  return createImagePreparer(fetcher.safeFetch)({ id: "image-one", imageUrl: "https://example.edu/photo", pageUrl: evidence.source.url,
    evidence: [evidence], policy: evidence.source.policy }, contextFixture());
}
const raster = (width = 400, height = 300) => sharp({ create: { width, height, channels: 3, background: { r: 50, g: 130, b: 200 } } });
it.each(["jpeg", "png", "webp"] as const)("decodes %s, strips metadata and hashes original and derivative", async (format) => {
  const original = await raster(1600, 1200).withMetadata().toFormat(format).toBuffer();
  const result = await prepare(original, `image/${format}`);
  expect(result.image).toMatchObject({ id: "image-one", mediaType: "image/jpeg", width: 1024, height: 768,
    originalSha256: createHash("sha256").update(original).digest("hex") });
  expect(result.image.sha256).toBe(createHash("sha256").update(result.image.bytes).digest("hex"));
  expect(result.image.byteLength).toBe(result.image.bytes.byteLength);
  expect(result.image.byteLength).toBeLessThanOrEqual(524288);
  const metadata = await sharp(result.image.bytes).metadata();
  expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined();
});
it.each(["svg", "html", "broken", "mismatch", "tiny-edge", "tiny-area", "too-many-pixels", "animated"])("rejects %s before AI", async (kind) => {
  let bytes: Uint8Array = await raster().png().toBuffer(); let mime = "image/png";
  if (kind === "svg") { bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'); mime = "image/svg+xml"; }
  if (kind === "html") bytes = Buffer.from("<html>not an image</html>");
  if (kind === "broken") bytes = bytes.slice(0, 45);
  if (kind === "mismatch") mime = "image/jpeg";
  if (kind === "tiny-edge") bytes = await raster(159, 500).png().toBuffer();
  if (kind === "tiny-area") bytes = await raster(200, 200).png().toBuffer();
  if (kind === "too-many-pixels") bytes = await raster(5000, 4001).png().toBuffer();
  if (kind === "animated") {
    const frames = Buffer.concat([Buffer.alloc(400 * 300 * 3, 90), Buffer.alloc(400 * 300 * 3, 200)]);
    bytes = await sharp(frames, { raw: { width: 400, height: 600, channels: 3, pageHeight: 300 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
    mime = "image/webp";
  }
  await expect(prepare(bytes, mime)).rejects.toMatchObject({ code: "invalid_media" });
});
it("accepts exact tiny-asset boundaries", async () => {
  const result = await prepare(await raster(160, 375).png().toBuffer(), "image/png");
  expect(result.image).toMatchObject({ width: 160, height: 375 });
});
it("reduces a noisy authored raster from quality 80 to 65 to meet 512 KiB", async () => {
  let value = 123456789; const pixels = Buffer.alloc(1024 * 1024 * 3);
  for (let i = 0; i < pixels.length; i++) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; pixels[i] = value & 255; }
  const original = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const at80 = await sharp(original).jpeg({ quality: 80 }).toBuffer();
  const at65 = await sharp(original).jpeg({ quality: 65 }).toBuffer();
  expect(at80.length).toBeGreaterThan(524288); expect(at65.length).toBeLessThanOrEqual(524288);
  const result = await prepare(original, "image/png");
  expect(result.image.bytes).toEqual(at65);
});
it("skips after exactly three oversized encoder derivatives", async () => {
  const original = await raster().png().toBuffer();
  const prototype = sharp.prototype as Sharp;
  const actualJpeg = prototype.jpeg;
  const qualities: number[] = [];
  // Fault-inject only encoder output; safe fetch, magic, metadata and policy remain real.
  const spy = vi.spyOn(prototype, "jpeg").mockImplementation(function (this: Sharp, options = {}) {
    qualities.push(options?.quality ?? 0);
    const pipeline = actualJpeg.call(this, options);
    pipeline.toBuffer = (() => Promise.resolve({ data: Buffer.alloc(524289), info: { width: 400, height: 300 } })) as unknown as typeof pipeline.toBuffer;
    return pipeline;
  });
  try { await expect(prepare(original, "image/png")).rejects.toMatchObject({ code: "invalid_media" }); }
  finally { spy.mockRestore(); }
  expect(qualities).toEqual([80, 65, 50]);
});
it("rejects encoded source bytes beyond 5,000,000", async () => {
  const bytes = Buffer.concat([await raster().jpeg().toBuffer(), Buffer.alloc(5_000_001)]);
  await expect(prepare(bytes, "image/jpeg")).rejects.toMatchObject({ code: "invalid_media" });
});
it("rejects APNG animation even when the decoder reports only its first page", async () => {
  const png = await raster().png().toBuffer();
  const payload = Buffer.alloc(12); payload.write("acTL"); payload.writeUInt32BE(2, 4);
  let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); payload.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 16);
  const animated = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  await expect(prepare(animated, "image/png")).rejects.toMatchObject({ code: "invalid_media" });
});
it("accepts exactly 20,000,000 decoded pixels and bounds the derivative", async () => {
  const result = await prepare(await raster(5000, 4000).png().toBuffer(), "image/png");
  expect(result.image).toMatchObject({ width: 1024, height: 819 });
});
it("rejects JPEG multi-picture metadata even when sharp exposes only one image", async () => {
  const jpeg = await raster().jpeg().toBuffer();
  const mpf = Buffer.from([0xff, 0xe2, 0x00, 0x06, 0x4d, 0x50, 0x46, 0x00]);
  await expect(prepare(Buffer.concat([jpeg.subarray(0, 2), mpf, jpeg.subarray(2)]), "image/jpeg"))
    .rejects.toMatchObject({ code: "invalid_media" });
});
