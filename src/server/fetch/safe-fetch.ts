import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, buildConnector, request } from "undici";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import type { FailureCode, FetchResult, RunContext } from "@/server/contracts";
import { createAccessPolicy, type AccessResult, type PublisherRule } from "./access-policy";

type FetchKind = "html" | "image" | "robots";
export interface FetchDependencies {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  connect?: buildConnector.connector;
  contactUrl?: string;
  publisherRules?: ReadonlyMap<string, PublisherRule>;
}

export class FetchFailure extends Error {
  constructor(readonly code: FailureCode, readonly retryAt?: number) { super(code); this.name = "FetchFailure"; }
}

const aborted = (signal: AbortSignal) => new FetchFailure(signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled");
function assertActive(ctx: RunContext) {
  if (ctx.signal.aborted) throw aborted(ctx.signal);
  if (Date.now() >= ctx.deadlineAt) throw new FetchFailure("deadline");
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Shared across fetcher instances in this Node process, including policy requests.
let active = 0;
const hosts = new Map<string, number>();
const pending: Array<{ host: string; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }> = [];
function drain() {
  for (let index = 0; index < pending.length && active < 6;) {
    const entry = pending[index];
    if ((hosts.get(entry.host) ?? 0) >= 2) { index++; continue; }
    pending.splice(index, 1);
    entry.signal.removeEventListener("abort", entry.abort);
    if (entry.signal.aborted) { entry.reject(aborted(entry.signal)); continue; }
    active++; hosts.set(entry.host, (hosts.get(entry.host) ?? 0) + 1);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true; active--;
      const remaining = hosts.get(entry.host)! - 1;
      if (remaining) hosts.set(entry.host, remaining); else hosts.delete(entry.host);
      drain();
    });
  }
}
function acquire(host: string, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const entry = { host, signal, resolve, reject, abort: () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      reject(aborted(signal));
    } };
    pending.push(entry); signal.addEventListener("abort", entry.abort, { once: true }); drain();
  });
}

function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch { return false; }
}
function validateUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new FetchFailure("unsafe_target"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.port && !["80", "443"].includes(url.port)) || !hostname
    || (isIP(hostname) && !publicAddress(hostname))) throw new FetchFailure("unsafe_target");
  url.hash = "";
  return url;
}
function byteLimit(limit: number) {
  let size = 0;
  return new Transform({ transform(chunk: Buffer, _, callback) {
    size += chunk.byteLength;
    callback(size > limit ? new FetchFailure("invalid_media") : null, chunk);
  } });
}
async function readBytes(body: Readable, encoding: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const output: Buffer[] = [];
  const sink = new Transform({ transform(chunk: Buffer, _, callback) { output.push(chunk); callback(); } });
  // One known content coding only. A stack of decoders is unnecessary attack surface.
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : undefined;
  if (encoding && encoding !== "identity" && !decoder) throw new FetchFailure("invalid_media");
  const streams = [body, byteLimit(limit), ...(decoder ? [decoder] : []), byteLimit(limit), sink];
  await pipeline(streams, { signal });
  return Buffer.concat(output);
}

export function createSafeFetcher(dependencies: FetchDependencies = {}) {
  const resolve = dependencies.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const connect = dependencies.connect ?? buildConnector({ rejectUnauthorized: true, allowH2: false, timeout: 3_000 });
  const counts = new WeakMap<RunContext, { html: number; image: number }>();
  const policy = createAccessPolicy({ contactUrl: dependencies.contactUrl, publisherRules: dependencies.publisherRules,
    fetchRobots: (url, ctx, owner) => rawFetch(url, "robots", ctx, owner) });

  async function rawFetch(value: string, kind: FetchKind, ctx: RunContext, owner: RunContext = ctx): Promise<FetchResult> {
    let url = validateUrl(value);
    const redirectUrls: string[] = [];
    if (!policy.userAgent) throw new FetchFailure("access_denied");
    for (let redirects = 0; ; redirects++) {
      assertActive(ctx);
      url = validateUrl(url.href);
      const permission = policy.preflight(url.href);
      if (!permission.allowed) throw new FetchFailure(permission.reason ?? "access_denied", permission.retryAt);
      if (kind === "robots") {
        // Charge redirected policy origins without recursively checking robots.
        const allowance = policy.claimOrigin(url.href, owner);
        if (!allowance.allowed) throw new FetchFailure(allowance.reason ?? "budget_exhausted");
      } else {
        const access = await policy.checkAccess(url.href, ctx, owner);
        if (!access.allowed) throw new FetchFailure(access.reason ?? "access_denied", access.retryAt);
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await withAbort(resolve(hostname), ctx.signal);
      if (!addresses.length || addresses.some(({ address, family }) => !publicAddress(address) || isIP(address) !== family)) throw new FetchFailure("unsafe_target");
      const selected = addresses[0];
      const release = await acquire(hostname, ctx.signal);
      // Host remains the URL's hostname. The socket gets only a validated numeric IP;
      // TLS still verifies the original hostname, and never performs a second lookup.
      const dispatcher = new Agent({ connect: (options, callback) => connect({ ...options,
        hostname: selected.address, servername: isIP(hostname) ? undefined : hostname }, callback),
        connections: 1, pipelining: 1, maxHeaderSize: 16_384 });
      let body: Readable | undefined;
      try {
        assertActive(ctx);
        const pacing = await policy.waitForStart(url.href, ctx);
        if (!pacing.allowed) throw new FetchFailure(pacing.reason ?? "access_denied", pacing.retryAt);
        if (kind !== "robots") {
          const count = counts.get(owner) ?? { html: 0, image: 0 };
          counts.set(owner, count);
          if (++count[kind] > (kind === "html" ? 8 : 24)) throw new FetchFailure("budget_exhausted");
        }
        const response = await request(url, { dispatcher, method: "GET", signal: ctx.signal,
          // Undici request does not follow redirects; no redirect interceptor is installed.
          headersTimeout: 3_000, bodyTimeout: 3_000,
          headers: { "user-agent": policy.userAgent, accept: kind === "html" ? "text/html, application/xhtml+xml" : kind === "robots" ? "text/plain" : "image/jpeg, image/png, image/webp", "accept-encoding": "gzip, deflate, br" } });
        body = response.body;
        // Rejected headers/redirects leave an unread body. Undici emits an abort
        // error on destroy; pipeline/request still report all operation failures.
        body.on("error", () => {});
        const header = (key: string) => { const value = response.headers[key]; return Array.isArray(value) ? value.join(",") : value ?? ""; };
        policy.noteResponse(url.href, response.statusCode, header("retry-after"));
        if (header("retry-after")) throw new FetchFailure("access_denied", policy.preflight(url.href).retryAt);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (redirects >= 3 || !header("location")) throw new FetchFailure("protocol_error");
          url = validateUrl(new URL(header("location"), url).href);
          redirectUrls.push(url.href);
          continue;
        }
        if (kind !== "robots" && (response.statusCode < 200 || response.statusCode >= 300 || header("retry-after"))) throw new FetchFailure("access_denied", policy.preflight(url.href).retryAt);
        if (/(?:^|[\s,:])(?:none|noai|noimageai|noimageindex)(?:$|[\s,])/i.test(header("x-robots-tag"))) throw new FetchFailure("access_denied");
        const contentType = header("content-type").toLowerCase();
        if (kind === "html" && !/^(text\/html|application\/xhtml\+xml)(?:;|$)/.test(contentType)) throw new FetchFailure("invalid_media");
        if (kind === "image" && !/^image\/(jpeg|png|webp)(?:;|$)/.test(contentType)) throw new FetchFailure("invalid_media");
        const bytes = await readBytes(body, header("content-encoding").toLowerCase().trim(), kind === "html" ? 2_000_000 : kind === "image" ? 5_000_000 : 512_000, ctx.signal);
        if (kind === "html") {
          const $ = load(new TextDecoder().decode(bytes));
          const restrictions = $("meta[name]").toArray()
            .filter((element) => ["robots", "visualuniversityprofile"].includes(($(element).attr("name") ?? "").toLowerCase()))
            .map((element) => $(element).attr("content") ?? "").join(",");
          if (/(?:^|[\s,])(?:none|noai|noimageai|noimageindex)(?:$|[\s,])/i.test(restrictions)) throw new FetchFailure("access_denied");
        }
        return { finalUrl: url.href, redirectUrls, contentType, bytes, status: response.statusCode, retrievedAt: new Date().toISOString() };
      } finally {
        body?.destroy();
        try { await dispatcher.destroy(); } finally { release(); }
      }
    }
  }

  async function bounded<T>(ctx: RunContext, operation: (boundedContext: RunContext) => Promise<T>): Promise<T> {
    assertActive(ctx);
    const remaining = Math.min(3_000, ctx.deadlineAt - Date.now());
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, remaining))]);
    try { return await operation({ ...ctx, signal, deadlineAt: Math.min(ctx.deadlineAt, Date.now() + remaining) }); }
    catch (error) {
      if (signal.aborted) throw aborted(signal);
      if (error instanceof FetchFailure) throw error;
      throw new FetchFailure("dependency_unavailable");
    }
  }
  async function safeFetch(url: string, kind: FetchKind, ctx: RunContext): Promise<FetchResult> {
    validateUrl(url);
    if (kind !== "robots") {
      const count = counts.get(ctx) ?? { html: 0, image: 0 };
      if (count[kind] >= (kind === "html" ? 8 : 24)) throw new FetchFailure("budget_exhausted");
    }
    return bounded(ctx, (boundedContext) => rawFetch(url, kind, boundedContext, ctx));
  }
  async function checkAccess(url: string, ctx: RunContext): Promise<AccessResult> {
    try { validateUrl(url); return await bounded(ctx, (boundedContext) => policy.checkAccess(url, boundedContext, ctx)); }
    catch (error) { return { allowed: false, reason: error instanceof FetchFailure ? error.code : "access_denied" }; }
  }
  return { safeFetch, checkAccess };
}

// A real project-owned HTTPS contact URL must be configured by the operator.
// No placeholder identity or route-controlled transport configuration is provided.
export const defaultFetcher = createSafeFetcher({ contactUrl: process.env.CRAWLER_CONTACT_URL });
export const safeFetch = defaultFetcher.safeFetch;
