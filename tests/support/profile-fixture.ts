import sharp from "sharp";
import type { Ledger } from "@/server/usage/ledger";
import { createSafeFetcher } from "@/server/fetch/safe-fetch";
import { createProfileServices } from "@/server/profile/services";
import { transportFixture } from "./fixtures";
export const fixtureOrigin = "https://app.example";
export const fixtureSecret = "authored-session-secret-at-least-32-characters";
export const fixtureGrant = { origin: "https://example.edu", retention: "transient_only" as const, display: "direct_permitted" as const,
  policyVersion: "fixture-v1", basis: ["Authored test publisher grants direct display"], attributionText: "Synthetic Author" };
export async function profileFixture(options: { conflict?: boolean; permit?: boolean; busy?: boolean; hangAi?: boolean; oversizedIdentity?: boolean; oversizedWire?: boolean; crossOrigin?: boolean; imageRedirect?: "external" | "roundtrip"; imageGrant?: boolean; caption?: string; universityName?: string; universityPlace?: string; grantExpiresAt?: string; onAssessment?: () => void; redirectMetadata?: "empty" | "missing-final" | "credentials" | "too-many" | "non-array" } = {}) {
  const universityName = options.universityName ?? "Example University";
  const universityPlace = options.universityPlace ?? "Example City";
  let released = 0, admitted = 0, providerCalls = 0, abortedAi = false;
  const interpretationContexts: unknown[] = [];
  const contexts: Array<{ startedAt: number; deadlineAt: number; requestId: string }> = [];
  const ledger: Ledger = { admit: async ctx => { admitted++; contexts.push(ctx); return { allowed: !options.busy, retryAfterSeconds: options.busy ? 2 : 0 }; },
    release: async () => { released++; }, check: async () => {}, renew: async () => {}, reserve: async () => "synthetic-reservation", settle: async () => {} };
  const raster = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#83977a" } }).png().toBuffer();
  const caption = options.caption ?? `${options.conflict ? "Partner University, Other City" : `${universityName}, ${universityPlace}`} campus courtyard.`;
  const html = `<html><title>${universityName}</title><body><h1>${universityName}</h1><address>${universityPlace}, Example Country <a href="mailto:info@example.edu">Contact</a></address><figure><img src="${options.crossOrigin ? "https://third-party.example/campus.png" : "/campus.png"}"><figcaption>${caption}</figcaption></figure></body></html>`;
  const transport = await transportFixture((request, response) => {
    if (request.url === "/robots.txt") { response.writeHead(404); response.end(); }
    else if (options.imageRedirect && request.headers.host === "example.edu" && request.url === "/campus.png") { response.writeHead(302, { location: `https://third-party.example/${options.imageRedirect === "roundtrip" ? "intermediate.png" : "campus.png"}` }); response.end(); }
    else if (options.imageRedirect === "roundtrip" && request.url === "/intermediate.png") { response.writeHead(302, { location: "https://example.edu/final.png" }); response.end(); }
    else if (["/campus.png", "/final.png"].includes(request.url ?? "")) { response.writeHead(200, { "content-type": "image/png" }); response.end(raster); }
    else { response.writeHead(200, { "content-type": "text/html" }); response.end(html); }
  });
  const safeFetcher = createSafeFetcher({ contactUrl: "https://visual-profile-project.org/contact", resolve: async () => [{ address: "93.184.216.34", family: 4 }], connect: transport.connector }).safeFetch;
  const fetcher: typeof safeFetcher = async (url, kind, ctx) => {
    const result = await safeFetcher(url, kind, ctx);
    if (kind !== "image" || !options.redirectMetadata) return result;
    // Fault injection at the transport-result boundary; all preceding fetch/media work is real.
    const metadata: unknown = options.redirectMetadata === "empty" ? []
      : options.redirectMetadata === "missing-final" ? ["https://third-party.example/intermediate.png"]
      : options.redirectMetadata === "credentials" ? ["https://user:pass@example.edu/intermediate.png", result.finalUrl]
      : options.redirectMetadata === "too-many" ? Array(4).fill(result.finalUrl) : result.finalUrl;
    return { ...result, redirectUrls: metadata as string[] };
  };
  const providerFetch: typeof fetch = async (url, init) => {
    providerCalls++;
    if (String(url).includes("wikidata.org")) {
      const action = new URL(String(url)).searchParams.get("action");
      return Response.json(action === "wbsearchentities" ? { success: 1, search: [{ id: "Q123", label: universityName }] }
        : { success: 1, entities: { Q123: { id: "Q123", labels: { en: { value: universityName } }, aliases: options.oversizedIdentity || options.oversizedWire ? { en: Array.from({ length: options.oversizedIdentity ? 51 : 50 }, (_, index) => ({ value: options.oversizedWire ? "字".repeat(1800) + index : `Alias ${index}` })) } : {}, descriptions: { en: { value: `university in ${universityPlace}, Example Country` } }, claims: { P856: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: "https://example.edu/" } } }] } } } });
    }
    if (String(url).includes("api.openai.com")) {
      if (options.hangAi) return new Promise<Response>((_resolve, reject) => { const stop = () => { abortedAi = true; reject(new DOMException("Aborted", "AbortError")); }; if (init?.signal?.aborted) stop(); else init?.signal?.addEventListener("abort", stop, { once: true }); });
      options.onAssessment?.();
      const body = JSON.parse(String(init?.body));
      const assessmentPayload = JSON.parse(body.input[0].content[0].text); interpretationContexts.push(assessmentPayload.selectedUniversityForComparison);
      const evidence = assessmentPayload.untrustedPublisherEvidence[0];
      const assessment = { imageId: evidence.imageId, assessed: true, category: "campus", visual: 10, safety: "clear", relevance: "relevant", authenticity: "photo", location: options.conflict ? "conflict" : "supported", evidenceIds: [evidence.id], observations: ["An outdoor courtyard with buildings."], uncertainties: [] };
      return Response.json({ id: "resp_fixture", object: "response", created_at: 1789574400, model: "gpt-5.6-luna", status: "completed", error: null, incomplete_details: null,
        output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ assessments: [assessment] }), annotations: [] }] }],
        usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    }
    throw new Error("Unexpected external request in fixture");
  };
  const services = createProfileServices({ ledger, fetcher, providerFetch, apiKey: "synthetic-key", model: "gpt-5.6-luna", braveKey: "synthetic-key", policies: options.permit === false ? new Map() : new Map([[fixtureGrant.origin, { ...fixtureGrant, ...(options.grantExpiresAt ? { expiresAt: options.grantExpiresAt } : {}) }], ...(options.imageGrant ? [["https://third-party.example", { ...fixtureGrant, origin: "https://third-party.example", attributionText: "Synthetic image host" }] as const] : [])]) });
  return { services, providerFetch, close: transport.close, raster, contexts, interpretationContexts, stats: () => ({ released, admitted, providerCalls, abortedAi }) };
}
