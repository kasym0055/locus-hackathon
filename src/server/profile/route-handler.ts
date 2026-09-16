import { randomUUID } from "node:crypto";
import { z } from "zod";
import { profileEventSchema } from "@/lib/event-schema";
import type { Emit } from "@/lib/events";
import { makeContext, REQUEST_DEADLINE_MS } from "@/server/limits";
import { hashClientIp } from "@/server/usage/ledger";
import { normalizeQuery } from "@/server/discovery/resolver";
import { createProfileRunner, failureCode } from "./run-profile";
import type { ProfileServices } from "./services";
import { fatalResponse, readSession, streamHeaders, validateOrigin, type SessionOptions } from "./session";
const querySchema = z.strictObject({ query: z.string().transform(normalizeQuery).pipe(z.string().min(2).max(160)), countryHint: z.string().trim().max(80).default("") });
async function readBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !request.body) throw { code: "invalid_request" };
  if (Number(request.headers.get("content-length") ?? 0) > 2048) throw { code: "invalid_request" };
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw { code: "deadline" };
      const { done, value } = await reader.read();
      if (signal.aborted) throw { code: "deadline" };
      if (done) break;
      size += value.byteLength; if (size > 2048) throw { code: "invalid_request" }; chunks.push(value);
    }
    try { return querySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch { throw { code: "invalid_request" }; }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createProfileHandler(options: SessionOptions & { services: () => Promise<ProfileServices> }) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now(), requestId = randomUUID(), abort = new AbortController();
    const disconnect = () => abort.abort(new Error("cancelled"));
    request.signal.addEventListener("abort", disconnect, { once: true });
    if (request.signal.aborted) disconnect();
    const timer = setTimeout(() => abort.abort(new DOMException("Deadline", "TimeoutError")), REQUEST_DEADLINE_MS);
    const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", disconnect); };
    let services: ProfileServices | undefined, admitted = false;
    try {
      validateOrigin(request, options);
      if (request.method !== "POST") throw { code: "invalid_request" };
      const sessionId = readSession(request, options.secret!, startedAt);
      if (!sessionId) throw { code: "invalid_request" };
      const query = await readBody(request, abort.signal);
      const ipHash = hashClientIp({ peerIp: options.clientIp?.(request) ?? "", secret: options.secret! });
      const ctx = makeContext({ requestId, sessionId, ipHash, signal: abort.signal, now: startedAt });
      services = await options.services();
      const admission = await services.ledger.admit(ctx); admitted = admission.allowed;
      if (!admitted) { cleanup(); return fatalResponse(requestId, "busy", 429, admission.retryAfterSeconds); }
      if (abort.signal.aborted || Date.now() >= ctx.deadlineAt) throw { code: failureCode(null, ctx) };
      let closed = false, sequence = 0, bytesSent = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const emit: Emit = event => {
            if (closed) return;
            const frame = profileEventSchema.parse({ v: 1, requestId, seq: sequence + 1, ...event });
            const bytes = encoder.encode(JSON.stringify(frame) + "\n");
            // Reserve room for a small fatal envelope if a final payload is too large.
            if (bytes.byteLength - 1 > 256 * 1024 || bytesSent + bytes.byteLength > 2 * 1024 * 1024 - (event.type === "fatal" ? 0 : 4096)) throw new Error("protocol_error");
            controller.enqueue(bytes); bytesSent += bytes.byteLength; sequence++;
            if (event.type === "final" || event.type === "fatal") { closed = true; controller.close(); cleanup(); }
          };
          void createProfileRunner(services!)(query, ctx, emit, true).catch(() => {
            emit({ type: "fatal", data: { code: "dependency_unavailable", message: "The request could not be completed." } });
          }).finally(cleanup);
        },
        cancel() { closed = true; disconnect(); cleanup(); },
      });
      return new Response(body, { headers: streamHeaders });
    } catch (error) {
      cleanup(); if (admitted && services) await services.ledger.release(requestId).catch(() => {});
      const code = failureCode(error); return fatalResponse(requestId, code, code === "invalid_request" ? 400 : 503);
    }
  };
}
