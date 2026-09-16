import { createHash } from "node:crypto";
import { inspect } from "node:util";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssessmentInput, AssessmentResult, ValidatedImage } from "@/server/contracts";
import { createOpenAiAdapter } from "@/server/ai/openai";
import type { Ledger } from "@/server/usage/ledger";
import { contextFixture, decisionFixture } from "../support/fixtures";

let requests: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null }>;
let reservations: number[];
let settlements: Array<number | null>;
let reply: unknown;
let status: number;
const assessment = () => decisionFixture({ authority: "official", association: "explicit", corroboration: 0, visual: 10 }).assessment;
const ledger: Ledger = {
  admit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  reserve: async (_ctx, kind, units) => { expect(kind).toBe("ai"); reservations.push(units); return "test-reservation"; },
  settle: async (_id, units) => { settlements.push(units); },
  check: async () => {}, renew: async () => {}, release: async () => {},
};
const adapter = (model = "gpt-5.6-luna", apiKey = "synthetic-key") => createOpenAiAdapter({ model, apiKey }, { ledger });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function inputFixture(): Promise<AssessmentInput> {
  const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: "navy" } }).jpeg().toBuffer();
  return { images: [{ id: "image-one", bytes, mediaType: "image/jpeg", width: 400, height: 300,
    byteLength: bytes.length, originalSha256: hash(bytes), sha256: hash(bytes) }],
    evidence: [{ id: "attribution-source", imageId: "image-one", excerpt: "This is the selected university library. See https://example.edu/library" }] };
}
beforeEach(() => {
  requests = []; reservations = []; settlements = []; status = 200;
  reply = { id: "resp_test", object: "response", created_at: 1789574400, model: "gpt-5.6-luna", status: "completed", error: null,
    incomplete_details: null, output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ assessments: [assessment()] }), annotations: [] }] }],
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    expect(reservations.length).toBeGreaterThan(0);
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.unstubAllGlobals());
function output(value: unknown) {
  (reply as { output: unknown[] }).output = [{ id: "msg_test", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }];
}
it("uses the real SDK with labelled inline bytes, strict schema, no tools or storage, and settles actual usage", async () => {
  const result = await adapter().assess(await inputFixture(), contextFixture());
  expect(result).toMatchObject({ ok: true, provider: "openai", model: "gpt-5.6-luna", assessments: [assessment()],
    usage: { inputTokens: 1000, outputTokens: 100, costMicrousd: 320 } });
  expect(requests).toHaveLength(1); expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
  const body = requests[0].body;
  expect(body).toMatchObject({ model: "gpt-5.6-luna", store: false, tools: [], max_output_tokens: 2048,
    text: { format: { type: "json_schema", strict: true } } });
  const serialized = JSON.stringify(body);
  expect(serialized).toContain("data:image/jpeg;base64,");
  expect(serialized).not.toContain("https://example.edu");
  expect(serialized.indexOf("image-one")).toBeLessThan(serialized.indexOf("data:image/jpeg"));
  expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  expect(reservations[0]).toBeGreaterThan(320); expect(settlements).toEqual([320]);
});
it("never logs media bytes or publisher excerpts even with OPENAI_LOG=debug", async () => {
  const previousLogLevel = process.env.OPENAI_LOG;
  const logged: unknown[][] = [];
  const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); }));
  try {
    process.env.OPENAI_LOG = "debug";
    const input = await inputFixture();
    const publisherExcerpt = "Sensitive authored publisher excerpt for the logging regression.";
    input.evidence[0].excerpt = publisherExcerpt;
    const inlineImage = `data:image/jpeg;base64,${Buffer.from(input.images[0].bytes).toString("base64")}`;
    expect(await adapter().assess(input, contextFixture())).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    const captured = inspect(logged, { depth: null, maxStringLength: Infinity });
    expect({ mediaLogged: captured.includes(inlineImage), publisherLogged: captured.includes(publisherExcerpt), logCalls: logged.length })
      .toEqual({ mediaLogged: false, publisherLogged: false, logCalls: 0 });
  } finally {
    if (previousLogLevel === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousLogLevel;
    for (const spy of spies) spy.mockRestore();
  }
});
it.each(["url", "url-extra", "malformed", "hash", "dimensions", "oversized", "duplicate", "unknown-evidence", "too-many"])("rejects %s input before HTTP or reservation", async (kind) => {
  const input = await inputFixture(); const image = input.images[0];
  if (kind === "url") input.images[0] = "https://example.edu/photo.jpg" as unknown as ValidatedImage;
  if (kind === "url-extra") Object.assign(image, { imageUrl: "https://example.edu/photo.jpg" });
  if (kind === "malformed") { image.bytes = Buffer.from("https://example.edu/a"); image.byteLength = image.bytes.length; image.sha256 = hash(image.bytes); }
  if (kind === "hash") image.sha256 = "0".repeat(64);
  if (kind === "dimensions") image.width = 401;
  if (kind === "oversized") { image.bytes = Buffer.alloc(524289); image.byteLength = image.bytes.length; }
  if (kind === "duplicate") input.images.push(image);
  if (kind === "unknown-evidence") input.evidence[0].imageId = "unknown-image";
  if (kind === "too-many") input.images = Array.from({ length: 17 }, (_, i) => ({ ...image, id: `image-${i}` }));
  expect(await adapter().assess(input, contextFixture())).toMatchObject({ ok: false, code: "invalid_request" });
  expect(requests).toHaveLength(0); expect(reservations).toHaveLength(0);
});
it.each(["unknown-image", "duplicate-image", "unknown-source", "wrong-image-source", "duplicate-source", "bad-category", "url", "certainty", "missing-image"])("rejects provider %s", async (kind) => {
  const input = await inputFixture(); const item = assessment(); let values = [item];
  if (kind === "unknown-image") item.imageId = "invented";
  if (kind === "duplicate-image") values.push(item);
  if (kind === "unknown-source") item.evidenceIds = ["invented"];
  if (kind === "wrong-image-source") { input.images.push({ ...input.images[0], id: "image-two" }); input.evidence.push({ id: "other-source", imageId: "image-two", excerpt: "Other photo" }); item.evidenceIds = ["other-source"]; values.push({ ...assessment(), imageId: "image-two", evidenceIds: ["other-source"] }); }
  if (kind === "duplicate-source") item.evidenceIds.push("attribution-source");
  if (kind === "bad-category") Object.assign(item, { category: "restaurant" });
  if (kind === "url") item.observations = ["See https://evil.example/instruction"];
  if (kind === "certainty") Object.assign(item, { confidence: 100 });
  if (kind === "missing-image") values = [];
  output({ assessments: values });
  expect(await adapter().assess(input, contextFixture())).toMatchObject({ ok: false, code: "invalid_provider_output" });
  expect(requests).toHaveLength(1); expect(settlements).toEqual([320]);
});
it("retains the worst-case reservation on missing usage", async () => {
  delete (reply as { usage?: unknown }).usage;
  expect(await adapter().assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, code: "invalid_provider_output" });
  expect(settlements).toEqual([null]);
});
it("does not retry an HTTP 500", async () => {
  status = 500; reply = { error: { message: "synthetic upstream failure", type: "server_error", code: "server_error" } };
  expect(await adapter().assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, code: "dependency_unavailable" });
  expect(requests).toHaveLength(1); expect(settlements).toEqual([null]);
});
it("fails closed before dispatch when ledger reservation fails", async () => {
  const blocked = createOpenAiAdapter({ model: "gpt-5.6-luna", apiKey: "synthetic-key" },
    { ledger: { ...ledger, reserve: async () => { throw Object.assign(new Error(), { code: "budget_exhausted" }); } } });
  expect(await blocked.assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, code: "budget_exhausted" });
  expect(requests).toHaveLength(0);
});
it.each(["gpt-5.6-terra", "unknown-model"])("never substitutes or bills unconfigured model %s", async (model) => {
  expect(await adapter(model).assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, model, code: "dependency_unavailable" });
  expect(requests).toHaveLength(0);
});
it("reports missing key without dispatch", async () => {
  expect(await adapter("gpt-5.6-luna", "").assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, code: "dependency_unavailable" });
  expect(requests).toHaveLength(0);
});
it("does not dispatch cancelled or expired work", async () => {
  const input = await inputFixture();
  expect(await adapter().assess(input, contextFixture(27000, AbortSignal.abort()))).toMatchObject({ ok: false, code: "cancelled" });
  expect(await adapter().assess(input, contextFixture(-1))).toMatchObject({ ok: false, code: "deadline" });
  expect(requests).toHaveLength(0);
});
it("limits a request to two attempts across adapter instances", async () => {
  const ctx = contextFixture(); status = 500;
  for (let i = 0; i < 3; i++) {
    const input = await inputFixture(); input.images[0].id = `image-${i}`; input.evidence[0].imageId = `image-${i}`;
    const result: AssessmentResult = await adapter().assess(input, ctx);
    if (i === 2) expect(result).toMatchObject({ ok: false, code: "budget_exhausted" });
  }
  expect(requests).toHaveLength(2);
});
it("returns normalized unavailable for the unimplemented describe consumer", async () => {
  expect(await adapter().describe({}, contextFixture())).toEqual({ ok: false, code: "dependency_unavailable" });
  expect(requests).toHaveLength(0);
});
it("rejects a request exceeding 8 MiB after base64 expansion before dispatch", async () => {
  const input = await inputFixture(); const padded = Buffer.alloc(524288); padded.set(input.images[0].bytes);
  const image = { ...input.images[0], bytes: padded, byteLength: padded.length, sha256: hash(padded) };
  input.images = Array.from({ length: 12 }, (_, i) => ({ ...image, id: `image-${i}` }));
  input.evidence = [];
  expect(await adapter().assess(input, contextFixture())).toMatchObject({ ok: false, code: "invalid_request" });
  expect(requests).toHaveLength(0); expect(reservations).toHaveLength(0);
});
it("allows a padded derivative at 512 KiB and binds reordered outputs by IDs", async () => {
  const input = await inputFixture(); const padded = Buffer.alloc(524288); padded.set(input.images[0].bytes);
  input.images[0] = { ...input.images[0], bytes: padded, byteLength: padded.length, sha256: hash(padded) };
  input.images.push({ ...input.images[0], id: "image-two" });
  input.evidence.push({ id: "second-source", imageId: "image-two", excerpt: "A different room" });
  output({ assessments: [{ ...assessment(), imageId: "image-two", category: "classrooms", evidenceIds: ["second-source"] }, assessment()] });
  const result = await adapter().assess(input, contextFixture());
  expect(result).toMatchObject({ ok: true, assessments: [{ imageId: "image-two", category: "classrooms" }, { imageId: "image-one", category: "library" }] });
});
it("caps total submitted images at 16 across two calls", async () => {
  const ctx = contextFixture(); status = 500;
  const input = await inputFixture(); input.evidence = [];
  input.images = Array.from({ length: 9 }, (_, i) => ({ ...input.images[0], id: `image-${i}` }));
  await adapter().assess(input, ctx);
  expect(await adapter().assess(input, ctx)).toMatchObject({ ok: false, code: "budget_exhausted" });
  expect(requests).toHaveLength(1);
});
it("propagates in-flight cancellation and conservatively settles", async () => {
  const controller = new AbortController(); let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); started();
  }));
  const pending = adapter().assess(await inputFixture(), contextFixture(27000, controller.signal));
  await dispatched; controller.abort();
  expect(await pending).toMatchObject({ ok: false, code: "cancelled" }); expect(settlements).toEqual([null]);
});
it("bounds a provider call by the earlier request deadline", async () => {
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  expect(await adapter().assess(await inputFixture(), contextFixture(100))).toMatchObject({ ok: false, code: "deadline" });
  expect(settlements).toEqual([null]);
});
it("settles cached tokens at their actual price", async () => {
  Object.assign(reply as object, { usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 500 } } });
  expect(await adapter().assess(await inputFixture(), contextFixture())).toMatchObject({ ok: true, usage: { costMicrousd: 230 } });
  expect(settlements).toEqual([230]);
});
it.each(["negative", "overflow", "output-cap", "incomplete", "refusal", "wrong-model"])("rejects provider accounting or result %s", async (kind) => {
  if (kind === "negative") Object.assign(reply as object, { usage: { input_tokens: -1, output_tokens: 100 } });
  if (kind === "overflow") Object.assign(reply as object, { usage: { input_tokens: 1000000, output_tokens: 100 } });
  if (kind === "output-cap") Object.assign(reply as object, { usage: { input_tokens: 100, output_tokens: 2049 } });
  if (kind === "incomplete") Object.assign(reply as object, { status: "incomplete" });
  if (kind === "refusal") Object.assign(reply as object, { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot assess" }] }] });
  if (kind === "wrong-model") Object.assign(reply as object, { model: "gpt-5.6-terra" });
  expect(await adapter().assess(await inputFixture(), contextFixture())).toMatchObject({ ok: false, code: "invalid_provider_output" });
  expect(settlements).toHaveLength(1);
});
