import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, buildConnector, request } from "undici";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import type { FailureCode, FetchResult, RunContext } from "@/server/contracts";
import { discoveryDeadlineAt } from "@/server/limits";
import { createAccessPolicy, type AccessResult, type PublisherRule } from "./access-policy";
import { reportLocalTimeout, type LocalTimeoutSink } from "@/server/discovery/timeout-diagnostics";

type FetchKind = "html" | "image" | "robots";
const HTML_ATTEMPT_LIMIT = 12;
const IMAGE_ATTEMPT_LIMIT = 24;
const LICENSED_FILE_ATTEMPT_LIMIT = HTML_ATTEMPT_LIMIT - 2;
function contentBudget(kind: Exclude<FetchKind, "robots">, phase: RunContext["publisherPhase"]) {
  if (kind === "image") return { limit: IMAGE_ATTEMPT_LIMIT, exhausted: "image_attempts" as const };
  if (phase === "licensed_file") return { limit: LICENSED_FILE_ATTEMPT_LIMIT, exhausted: "licensed_file_attempts" as const };
  return { limit: HTML_ATTEMPT_LIMIT, exhausted: "html_attempts" as const };
}
type FetchAttempt = { ordinal: number; kind: FetchKind; phase: NonNullable<RunContext["publisherPhase"]> | "unspecified";
  hop: number; origin: number; target: number; startedMs: number; durationMs?: number; status?: number; failure?: FailureCode };
export interface PublisherBudgetReport {
  requestId: string; exhausted: "html_attempts" | "licensed_file_attempts" | "image_attempts" | "policy_origins"; limit: number;
  dispatched: Record<FetchKind, number>; attempts: FetchAttempt[];
  blocked: Omit<FetchAttempt, "ordinal" | "durationMs" | "status" | "failure">;
}
export interface PublisherAccessDeniedReport {
  event: "publisher_access_denied";
  requestId: string; phase: FetchAttempt["phase"]; kind: FetchKind; hop: number;
  origin: number; target: number; status?: number;
  source: "preflight_policy" | "robots_policy" | "crawl_pacing" | "retry_after"
    | "http_status" | "x_robots_tag" | "meta_robots";
  retryAtPresent: boolean; retryAfterMs?: number; elapsedMs: number;
}
export interface FetchDependencies {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  connect?: buildConnector.connector;
  contactUrl?: string;
  publisherRules?: ReadonlyMap<string, PublisherRule>;
  onBudgetExhausted?: (report: PublisherBudgetReport) => void;
  onAccessDenied?: (report: PublisherAccessDeniedReport) => void | Promise<void>;
  onLocalTimeout?: LocalTimeoutSink;
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
  const connect = dependencies.connect ?? buildConnector({ rejectUnauthorized: true, allowH2: false, timeout: 10_000 });
  const counts = new WeakMap<RunContext, { html: number; image: number }>();
  // Separate from budget traces: at most 16 reports, origins and targets per run.
  // IDs describe denial targets only and restart for each request; no stable hashes.
  const denials = new WeakMap<RunContext, { count: number; origins: Map<string, number>; targets: Map<string, number> }>();
  function reportDenial(owner: RunContext, ctx: RunContext, url: URL, kind: FetchKind, hop: number,
    source: PublisherAccessDeniedReport["source"], retryAt?: number, status?: number) {
    if (!dependencies.onAccessDenied) return;
    try {
      let trace = denials.get(owner);
      if (!trace) { trace = { count: 0, origins: new Map(), targets: new Map() }; denials.set(owner, trace); }
      if (trace.count >= 16) return;
      trace.count++;
      if (!trace.origins.has(url.origin)) trace.origins.set(url.origin, trace.origins.size + 1);
      if (!trace.targets.has(url.href)) trace.targets.set(url.href, trace.targets.size + 1);
      const now = Date.now();
      const report: PublisherAccessDeniedReport = { event: "publisher_access_denied", requestId: owner.requestId,
        phase: ctx.publisherPhase ?? "unspecified", kind, hop, source,
        origin: trace.origins.get(url.origin)!, target: trace.targets.get(url.href)!,
        ...(status === undefined ? {} : { status }), retryAtPresent: retryAt !== undefined,
        ...(Number.isFinite(retryAt) ? { retryAfterMs: Math.min(86_400_000, Math.max(0, retryAt! - now)) } : {}),
        elapsedMs: Math.max(0, now - owner.startedAt) };
      // Never await diagnostics or allow synchronous/asynchronous sink failures
      // to replace the transport result or interfere with socket cleanup.
      void Promise.resolve(dependencies.onAccessDenied(report)).catch(() => {});
    } catch { /* diagnostics only */ }
  }
  function accessFailure(owner: RunContext, ctx: RunContext, url: URL, kind: FetchKind, hop: number,
    source: PublisherAccessDeniedReport["source"], code: FailureCode = "access_denied", retryAt?: number, status?: number) {
    if (code === "access_denied") reportDenial(owner, ctx, url, kind, hop, source, retryAt, status);
    return new FetchFailure(code, retryAt);
  }
  // Request-local numeric IDs preserve repeated targets/redirects without logging
  // URLs, queries, publisher content, credentials, or stable target fingerprints.
  const traces = new WeakMap<RunContext, { attempts: FetchAttempt[]; origins: Map<string, number>; targets: Map<string, number>; reported: boolean }>();
  function traceFor(owner: RunContext) {
    let trace = traces.get(owner);
    if (!trace) { trace = { attempts: [], origins: new Map(), targets: new Map(), reported: false }; traces.set(owner, trace); }
    return trace;
  }
  function target(owner: RunContext, ctx: RunContext, url: URL, kind: FetchKind, hop: number) {
    const trace = traceFor(owner);
    const id = (map: Map<string, number>, key: string) => {
      if (!map.has(key)) map.set(key, map.size + 1);
      return map.get(key)!;
    };
    return { kind, phase: ctx.publisherPhase ?? "unspecified" as const, hop,
      origin: id(trace.origins, url.origin), target: id(trace.targets, url.href), startedMs: Math.max(0, Date.now() - owner.startedAt) };
  }
  function budgetFailure(owner: RunContext, ctx: RunContext, url: URL, kind: FetchKind, hop: number, exhausted: PublisherBudgetReport["exhausted"]) {
    if (dependencies.onBudgetExhausted) {
      const trace = traceFor(owner);
      if (!trace.reported) {
        trace.reported = true;
        const blocked = target(owner, ctx, url, kind, hop);
        const dispatched = { html: 0, image: 0, robots: 0 };
        for (const attempt of trace.attempts) dispatched[attempt.kind]++;
        // A diagnostic sink must never change transport enforcement or cleanup.
        const limit = exhausted === "image_attempts" ? IMAGE_ATTEMPT_LIMIT : exhausted === "html_attempts" ? HTML_ATTEMPT_LIMIT
          : exhausted === "licensed_file_attempts" ? LICENSED_FILE_ATTEMPT_LIMIT : 8;
        try { dependencies.onBudgetExhausted({ requestId: owner.requestId, exhausted, limit,
          dispatched, blocked, attempts: trace.attempts.map(attempt => ({ ...attempt })) }); } catch { /* diagnostics only */ }
      }
    }
    return new FetchFailure("budget_exhausted");
  }
  const policy = createAccessPolicy({ contactUrl: dependencies.contactUrl, publisherRules: dependencies.publisherRules,
    fetchRobots: (url, ctx, owner) => rawFetch(url, "robots", ctx, owner) });

  async function rawFetch(value: string, kind: FetchKind, ctx: RunContext, owner: RunContext = ctx): Promise<FetchResult> {
    let url = validateUrl(value);
    const redirectUrls: string[] = [];
    if (!policy.userAgent) throw accessFailure(owner, ctx, url, kind, 0, "preflight_policy");
    for (let redirects = 0; ; redirects++) {
      assertActive(ctx);
      url = validateUrl(url.href);
      const permission = policy.preflight(url.href);
      if (!permission.allowed) throw accessFailure(owner, ctx, url, kind, redirects, "preflight_policy", permission.reason, permission.retryAt);
      if (kind === "robots") {
        // Charge redirected policy origins without recursively checking robots.
        const allowance = policy.claimOrigin(url.href, owner);
        if (!allowance.allowed) throw allowance.reason === "budget_exhausted"
          ? budgetFailure(owner, ctx, url, kind, redirects, "policy_origins") : new FetchFailure(allowance.reason ?? "budget_exhausted");
      } else {
        const access = await policy.checkAccess(url.href, ctx, owner);
        if (!access.allowed) throw access.reason === "budget_exhausted"
          ? budgetFailure(owner, ctx, url, kind, redirects, "policy_origins") : accessFailure(owner, ctx, url, kind, redirects, "robots_policy", access.reason, access.retryAt);
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
      let attempt: FetchAttempt | undefined;
      try {
        assertActive(ctx);
        const pacing = await policy.waitForStart(url.href, ctx);
        if (!pacing.allowed) throw accessFailure(owner, ctx, url, kind, redirects, "crawl_pacing", pacing.reason, pacing.retryAt);
        if (kind !== "robots") {
          const count = counts.get(owner) ?? { html: 0, image: 0 };
          counts.set(owner, count);
          const budget = contentBudget(kind, ctx.publisherPhase);
          if (count[kind] >= budget.limit) throw budgetFailure(owner, ctx, url, kind, redirects, budget.exhausted);
          count[kind]++;
        }
        if (dependencies.onBudgetExhausted) {
          const trace = traceFor(owner);
          // Twelve HTML + 24 image + at most eight four-hop robots chains.
          if (!trace.reported && trace.attempts.length < 64) {
            attempt = { ...target(owner, ctx, url, kind, redirects), ordinal: trace.attempts.length + 1 };
            trace.attempts.push(attempt);
          }
        }
        const response = await request(url, { dispatcher, method: "GET", signal: ctx.signal,
          // Undici request does not follow redirects; no redirect interceptor is installed.
          headersTimeout: 10_000, bodyTimeout: 10_000,
          headers: { "user-agent": policy.userAgent, accept: kind === "html" ? "text/html, application/xhtml+xml" : kind === "robots" ? "text/plain" : "image/jpeg, image/png, image/webp", "accept-encoding": "gzip, deflate, br" } });
        body = response.body;
        if (attempt) attempt.status = response.statusCode;
        // Rejected headers/redirects leave an unread body. Undici emits an abort
        // error on destroy; pipeline/request still report all operation failures.
        body.on("error", () => {});
        const header = (key: string) => { const value = response.headers[key]; return Array.isArray(value) ? value.join(",") : value ?? ""; };
        policy.noteResponse(url.href, response.statusCode, header("retry-after"));
        if (header("retry-after")) throw accessFailure(owner, ctx, url, kind, redirects, "retry_after", "access_denied", policy.preflight(url.href).retryAt, response.statusCode);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (redirects >= 3 || !header("location")) throw new FetchFailure("protocol_error");
          url = validateUrl(new URL(header("location"), url).href);
          redirectUrls.push(url.href);
          continue;
        }
        if (kind !== "robots" && (response.statusCode < 200 || response.statusCode >= 300 || header("retry-after"))) throw accessFailure(owner, ctx, url, kind, redirects, "http_status", "access_denied", policy.preflight(url.href).retryAt, response.statusCode);
        if (/(?:^|[\s,:])(?:none|noai|noimageai|noimageindex)(?:$|[\s,])/i.test(header("x-robots-tag"))) throw accessFailure(owner, ctx, url, kind, redirects, "x_robots_tag", "access_denied", undefined, response.statusCode);
        const contentType = header("content-type").toLowerCase();
        if (kind === "html" && !/^(text\/html|application\/xhtml\+xml)(?:;|$)/.test(contentType)) throw new FetchFailure("invalid_media");
        if (kind === "image" && !/^image\/(jpeg|png|webp)(?:;|$)/.test(contentType)) throw new FetchFailure("invalid_media");
        const bytes = await readBytes(body, header("content-encoding").toLowerCase().trim(), kind === "html" ? 2_000_000 : kind === "image" ? 5_000_000 : 512_000, ctx.signal);
        if (kind === "html") {
          const $ = load(new TextDecoder().decode(bytes));
          const restrictions = $("meta[name]").toArray()
            .filter((element) => ["robots", "visualuniversityprofile"].includes(($(element).attr("name") ?? "").toLowerCase()))
            .map((element) => $(element).attr("content") ?? "").join(",");
          if (/(?:^|[\s,])(?:none|noai|noimageai|noimageindex)(?:$|[\s,])/i.test(restrictions)) throw accessFailure(owner, ctx, url, kind, redirects, "meta_robots", "access_denied", undefined, response.statusCode);
        }
        return { finalUrl: url.href, redirectUrls, contentType, bytes, status: response.statusCode, retrievedAt: new Date().toISOString() };
      } catch (error) {
        if (attempt) attempt.failure = error instanceof FetchFailure ? error.code : ctx.signal.aborted ? aborted(ctx.signal).code : "dependency_unavailable";
        throw error;
      } finally {
        if (attempt) attempt.durationMs = Math.max(0, Date.now() - owner.startedAt - attempt.startedMs);
        body?.destroy();
        try { await dispatcher.destroy(); } finally { release(); }
      }
    }
  }

  async function bounded<T extends FetchResult | AccessResult>(ctx: RunContext, kind: FetchKind, operation: (boundedContext: RunContext) => Promise<T>): Promise<T> {
    assertActive(ctx);
    // Resolution and discovery share one request-local window. Image
    // preparation may use the remaining request time; the outer 27s deadline
    // still bounds every socket and operation.
    const operationDeadline = ctx.publisherPhase === "image_preparation" ? ctx.deadlineAt : discoveryDeadlineAt(ctx);
    const remaining = Math.max(1, operationDeadline - Date.now());
    const local = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([ctx.signal, local]);
    const reportTimeout = () => reportLocalTimeout(ctx, local, signal, remaining, { component: "publisher", kind,
      phase: ctx.publisherPhase ?? "unspecified" }, dependencies.onLocalTimeout);
    try {
      const result = await operation({ ...ctx, signal, deadlineAt: operationDeadline });
      // Direct policy checks return their failure instead of throwing it.
      if ("allowed" in result && !result.allowed && result.reason === "deadline") reportTimeout();
      return result;
    }
    catch (error) {
      reportTimeout();
      if (signal.aborted) throw aborted(signal);
      if (error instanceof FetchFailure) throw error;
      throw new FetchFailure("dependency_unavailable");
    }
  }
  async function safeFetch(url: string, kind: FetchKind, ctx: RunContext): Promise<FetchResult> {
    const validatedUrl = validateUrl(url);
    if (kind !== "robots") {
      const count = counts.get(ctx) ?? { html: 0, image: 0 };
      const budget = contentBudget(kind, ctx.publisherPhase);
      if (count[kind] >= budget.limit) throw budgetFailure(ctx, ctx, validatedUrl, kind, 0, budget.exhausted);
    }
    return bounded(ctx, kind, (boundedContext) => rawFetch(url, kind, boundedContext, ctx));
  }
  async function checkAccess(url: string, ctx: RunContext): Promise<AccessResult> {
    try {
      validateUrl(url);
      const result = await bounded(ctx, "robots", (boundedContext) => policy.checkAccess(url, boundedContext, ctx));
      // This public method performs only a robots/access-policy check; it does
      // not dispatch content or know whether its caller intends HTML or an image.
      if (!result.allowed && result.reason === "access_denied") {
        reportDenial(ctx, ctx, validateUrl(url), "robots", 0, "robots_policy", result.retryAt);
      }
      return result;
    }
    catch (error) { return { allowed: false, reason: error instanceof FetchFailure ? error.code : "access_denied" }; }
  }
  return { safeFetch, checkAccess };
}

// A real project-owned HTTPS contact URL must be configured by the operator.
// No placeholder identity or route-controlled transport configuration is provided.
export const defaultFetcher = createSafeFetcher({ contactUrl: process.env.CRAWLER_CONTACT_URL,
  onBudgetExhausted: report => console.warn(JSON.stringify({ event: "publisher_budget_exhausted", ...report })),
  onAccessDenied: report => console.warn(JSON.stringify(report)) });
export const safeFetch = defaultFetcher.safeFetch;
