import robotsParser from "robots-parser";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { FailureCode, FetchResult, RunContext, UsagePolicy } from "@/server/contracts";
export interface AccessResult { allowed: boolean; retryAt?: number; reason?: FailureCode }
export interface PublisherRule { crawl: "allow" | "deny"; policy?: UsagePolicy }

export function crawlerIdentity(contactUrl?: string): string | undefined {
  try {
    if (!contactUrl) return;
    const contact = new URL(contactUrl);
    const host = contact.hostname;
    if (contact.protocol !== "https:" || contact.username || contact.password || contact.port || isIP(host)
      || !host.includes(".") || /(^|\.)(localhost|example\.(com|org|net|edu)|test|invalid|local)$/.test(host)) return;
    return `VisualUniversityProfile/0.1 (+${contact.href})`;
  } catch { return; }
}

export function createAccessPolicy(options: {
  contactUrl?: string;
  publisherRules?: ReadonlyMap<string, PublisherRule>;
  fetchRobots: (url: string, ctx: RunContext) => Promise<FetchResult>;
}) {
  const userAgent = crawlerIdentity(options.contactUrl);
  const states = new WeakMap<RunContext, Map<string, Promise<{ text: string; fetchedAt: number } | AccessResult>>>();
  const blockedUntil = new Map<string, number>();
  const pacingByOrigin = new Map<string, { readyAt: number; delayMs: number }>();
  const denied: AccessResult = { allowed: false, reason: "access_denied" };

  function noteResponse(url: string, status: number, retryAfter?: string) {
    if (![429, 503].includes(status) && !retryAfter) return;
    const now = Date.now();
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    const parsed = seconds === undefined ? Date.parse(retryAfter ?? "") : now + seconds * 1_000;
    const retryAt = Number.isFinite(parsed) && parsed > now ? parsed : now + 60_000;
    blockedUntil.set(new URL(url).origin, retryAt);
    // Policy state has no content and is bounded; retain active denials conservatively.
    for (const [origin, expiry] of blockedUntil) if (expiry <= now) blockedUntil.delete(origin);
  }

  function preflight(url: string): AccessResult {
    if (!userAgent) return denied;
    const origin = new URL(url).origin;
    for (const [key, expiry] of blockedUntil) if (expiry <= Date.now()) blockedUntil.delete(key);
    const rule = options.publisherRules?.get(origin);
    if (rule?.crawl === "deny" || rule?.policy?.retention === "disallowed") return denied;
    const blocked = blockedUntil.get(origin);
    if (blocked && blocked > Date.now()) return { ...denied, retryAt: blocked };
    if ((!blockedUntil.has(origin) && blockedUntil.size >= 2_048)
      || (!pacingByOrigin.has(origin) && pacingByOrigin.size >= 2_048)) return { allowed: false, reason: "busy" };
    return { allowed: true };
  }

  async function checkAccess(url: string, ctx: RunContext, owner: RunContext = ctx): Promise<AccessResult> {
    const permission = preflight(url);
    if (!permission.allowed) return permission;
    const target = new URL(url);
    const origin = target.origin;
    let state = states.get(owner);
    if (!state) { state = new Map(); states.set(owner, state); }
    if (!state.has(origin)) {
      if (state.size >= 8) return { allowed: false, reason: "budget_exhausted" };
      const promise = (async () => {
        try {
          const response = await options.fetchRobots(`${origin}/robots.txt`, ctx);
          if (response.status === 404) return { text: "", fetchedAt: Date.now() };
          if (response.status !== 200 || !/^text\/plain(?:;|$)/i.test(response.contentType)) return { ...denied, retryAt: blockedUntil.get(origin) };
          const text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
          if (/<(?:!doctype|html|script)\b/i.test(text)) return denied;
          // Empty/comment-only robots is valid. Unknown text is not evidence of access.
          const directives = text.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
          if (directives.some((line) => !/^[a-z][a-z-]*\s*:/i.test(line))
            || (directives.length && !directives.some((line) => /^(user-agent|sitemap)\s*:/i.test(line)))) return denied;
          if (directives.some((line) => /^crawl-delay\s*:/i.test(line) && !/^crawl-delay\s*:\s*\d+(?:\.\d+)?\s*$/i.test(line))) return denied;
          return { text, fetchedAt: Date.now() };
        } catch (error) {
          const { code, retryAt } = error as { code?: FailureCode; retryAt?: number };
          return { allowed: false, reason: code === "unsafe_target" || code === "deadline" || code === "cancelled" ? code : "access_denied", retryAt } satisfies AccessResult;
        }
      })();
      state.set(origin, promise);
    }
    const result = await state.get(origin)!;
    if ("allowed" in result) return result;
    const afterFetch = preflight(url);
    if (!afterFetch.allowed) return afterFetch;
    const robots = robotsParser(`${origin}/robots.txt`, result.text);
    if (robots.isAllowed(target.href, userAgent) !== true) return denied;
    const crawlDelay = robots.getCrawlDelay(userAgent);
    if (crawlDelay !== undefined && (!Number.isFinite(crawlDelay) || crawlDelay < 0)) return denied;
    const pacing = (crawlDelay ?? 0) * 1_000;
    const readyAt = Math.max(pacingByOrigin.get(origin)?.readyAt ?? 0, result.fetchedAt + pacing);
    if (pacing > 0) pacingByOrigin.set(origin, { readyAt, delayMs: Math.max(pacing, pacingByOrigin.get(origin)?.delayMs ?? 0) });
    if (readyAt >= ctx.deadlineAt) return { allowed: false, reason: "deadline", retryAt: readyAt };
    return { allowed: true };
  }

  // Called after acquiring socket slots, immediately before every outbound
  // request (including robots). Recheck after waiting to avoid timer/queue bursts.
  async function waitForStart(url: string, ctx: RunContext): Promise<AccessResult> {
    const origin = new URL(url).origin;
    for (;;) {
      const permission = preflight(url);
      if (!permission.allowed) return permission;
      const pace = pacingByOrigin.get(origin);
      const now = Date.now();
      if (ctx.signal.aborted) return { allowed: false, reason: ctx.signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled" };
      if (!pace || pace.readyAt <= now) {
        if (pace) pace.readyAt = now + pace.delayMs;
        for (const [key, record] of pacingByOrigin) if (key !== origin && record.readyAt <= now) pacingByOrigin.delete(key);
        return { allowed: true };
      }
      if (pace.readyAt >= ctx.deadlineAt) return { allowed: false, reason: "deadline", retryAt: pace.readyAt };
      try { await delay(pace.readyAt - now, undefined, { signal: ctx.signal }); }
      catch { return { allowed: false, reason: ctx.signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled" }; }
    }
  }
  return { checkAccess, noteResponse, preflight, waitForStart, userAgent };
}

export async function checkAccess(url: string, ctx: RunContext): Promise<AccessResult> {
  const { defaultFetcher } = await import("./safe-fetch");
  return defaultFetcher.checkAccess(url, ctx);
}
