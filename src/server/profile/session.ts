import { createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import type { FailureCode } from "@/server/contracts";
export interface SessionOptions { origin?: string; secret?: string; clientIp?: (request: Request) => string }
export const streamHeaders = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "x-accel-buffering": "no" };
export function fatalResponse(requestId: string, code: FailureCode, status: number, retryAfterSeconds?: number): Response {
  return new Response(JSON.stringify({ v: 1, requestId, seq: 1, type: "fatal", data: { code, message: code === "invalid_request" ? "The request is invalid." : "The service is unavailable. Please try again later.", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) } }) + "\n",
    { status, headers: { ...streamHeaders, ...(retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {}) } });
}
export function validateOrigin(request: Request, options: SessionOptions) {
  if (!options.origin || !options.secret || options.secret.length < 32) throw { code: "dependency_unavailable" };
  let configured: URL;
  try { configured = new URL(options.origin); } catch { throw { code: "dependency_unavailable" }; }
  if (configured.origin !== options.origin || configured.username || configured.password) throw { code: "dependency_unavailable" };
  if (request.headers.get("origin") !== options.origin || request.headers.get("sec-fetch-site") === "cross-site") throw { code: "invalid_request" };
}
const signature = (payload: string, secret: string) => createHmac("sha256", secret).update(`vup-session-v1:${payload}`).digest("base64url");
export function readSession(request: Request, secret: string, now = Date.now()): string | undefined {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith("vup_session="));
  if (cookies.length !== 1) return;
  const token = cookies[0].slice("vup_session=".length);
  const match = /^([A-Za-z0-9_-]{43})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return;
  const [, id, expires, signed] = match, expiry = Number(expires);
  if (expiry <= now || expiry > now + 24 * 60 * 60 * 1000) return;
  const expected = signature(`${id}.${expires}`, secret);
  if (!timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return;
  return id;
}
export function createSessionHandler(options: SessionOptions) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      validateOrigin(request, options);
      if (request.method !== "POST") throw { code: "invalid_request" };
      // Reuse a valid signed session; refreshing must not reset the admission bucket.
      if (readSession(request, options.secret!)) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      const payload = `${randomBytes(32).toString("base64url")}.${Date.now() + 24 * 60 * 60 * 1000}`;
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": `vup_session=${payload}.${signature(payload, options.secret!)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` } });
    } catch (error) {
      const code = (error as { code?: string }).code === "invalid_request" ? "invalid_request" : "dependency_unavailable";
      return fatalResponse(requestId, code, code === "invalid_request" ? 400 : 503);
    }
  };
}
export function productionSessionOptions(): SessionOptions {
  return { origin: process.env.APP_ORIGIN, secret: process.env.SESSION_SECRET,
    clientIp(request) {
      // Only Vercel's overwriting edge is supported. Self-hosting requires an
      // explicit trusted adapter; arbitrary client forwarding is never accepted.
      if (process.env.VERCEL !== "1") throw { code: "dependency_unavailable" };
      const ip = request.headers.get("x-forwarded-for");
      if (!ip || ip.includes(",")) throw { code: "invalid_request" };
      return ip.trim();
    } };
}
