import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Redis } from "@upstash/redis";
import type { FailureCode, RunContext } from "@/server/contracts";

export type EvalScript = (script: string, keys: string[], args: string[]) => Promise<unknown>;
export type Pool = "development" | "acceptance" | "judging";
export type BravePools = Record<Pool, number>;
export interface Ledger {
  admit(ctx: RunContext): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  reserve(ctx: RunContext, kind: "brave" | "ai" | "tavily", units: number): Promise<string>;
  settle(reservationId: string, actualUnits: number | null): Promise<void>;
  release(requestId: string): Promise<void>;
  check(ctx: RunContext): Promise<void>;
  renew(ctx: RunContext): Promise<void>;
}
export class LedgerFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "LedgerFailure"; }
}
export interface LedgerOptions {
  namespace?: string; pool?: Pool; bravePools?: BravePools;
  aiAllowanceMicrousd?: number; aiProfileCapMicrousd?: number; tavilyAllowanceCredits?: number;
}
const script = readFileSync(new URL("./ledger.lua", import.meta.url), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new LedgerFailure("invalid_request");
  return value;
}
function active(ctx: RunContext) {
  if (ctx.signal.aborted) throw new LedgerFailure("cancelled");
  if (Date.now() >= ctx.deadlineAt) throw new LedgerFailure("deadline");
}
export function allocateBravePools(verifiedAvailableCalls: number): BravePools {
  integer(verifiedAvailableCalls);
  const judging = Math.min(200, verifiedAvailableCalls);
  const remaining = Math.min(800, verifiedAvailableCalls - judging);
  const acceptance = Math.floor(remaining / 4);
  return { development: Math.min(600, remaining - acceptance), acceptance, judging };
}

export function createLedger(evalScript: EvalScript, options: LedgerOptions = {}): Ledger {
  const namespace = options.namespace ?? "visual-university-ledger-v1";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(namespace)) throw new LedgerFailure("invalid_request");
  const prefix = `{${namespace}}:`;
  const pool = options.pool ?? "development";
  const pools = options.bravePools ?? allocateBravePools(0);
  const tavilyAllowance = integer(options.tavilyAllowanceCredits ?? 0);
  const aiAllowance = integer(options.aiAllowanceMicrousd ?? 4_000_000);
  const aiProfileCap = integer(options.aiProfileCapMicrousd ?? 20_000);
  for (const amount of Object.values(pools)) integer(amount);
  const key = (kind: string, value: string) => `${prefix}${kind}:${hash(value)}`;
  const lease = (requestId: string) => key("lease", requestId);
  const activeKey = `${prefix}active`;
  async function execute(keys: string[], args: Array<string | number>): Promise<unknown> {
    try { return await evalScript(script, keys, args.map(String)); }
    catch { throw new LedgerFailure("dependency_unavailable"); }
  }
  async function checkOrRenew(ctx: RunContext, operation: string) {
    active(ctx);
    const result = await execute([lease(ctx.requestId), activeKey, key("session", ctx.sessionId)], [operation, hash(ctx.requestId)]);
    if (result !== 1) throw new LedgerFailure("busy");
    active(ctx);
  }
  return {
    async admit(ctx) {
      active(ctx);
      const result = await execute([activeKey, key("session", ctx.sessionId), key("ip", ctx.ipHash), key("bucket", ctx.sessionId), lease(ctx.requestId)], ["admit", hash(ctx.requestId)]);
      if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(Number(result[0])) || !Number.isFinite(Number(result[1]))) throw new LedgerFailure("dependency_unavailable");
      return { allowed: Number(result[0]) === 1, retryAfterSeconds: Math.max(0, Number(result[1])) };
    },
    async reserve(ctx, kind, units) {
      active(ctx); integer(units);
      if (!units || !["ai", "brave", "tavily"].includes(kind)) throw new LedgerFailure("invalid_request");
      const reservationId = randomUUID();
      const aggregateKey = `${prefix}used:${kind}:${kind === "brave" ? pool : "all"}`;
      const requestKey = key(`request-used:${kind}`, ctx.requestId);
      const result = await execute([`${prefix}reservation:${reservationId}`, aggregateKey, requestKey, lease(ctx.requestId), activeKey, key("session", ctx.sessionId), `${prefix}reservation-meta:${reservationId}`],
        ["reserve", units, kind === "brave" ? pools[pool] : kind === "tavily" ? tavilyAllowance : aiAllowance, kind === "brave" ? 10 : kind === "tavily" ? 4 : aiProfileCap, hash(ctx.requestId)]);
      if (result === -1) throw new LedgerFailure("busy");
      if (result === 0) throw new LedgerFailure("budget_exhausted");
      if (result !== 1) throw new LedgerFailure("dependency_unavailable");
      return reservationId;
    },
    async settle(reservationId, actualUnits) {
      if (!/^[a-f\d-]{36}$/.test(reservationId)) throw new LedgerFailure("invalid_request");
      if (actualUnits !== null) integer(actualUnits);
      const result = await execute([`${prefix}reservation:${reservationId}`, `${prefix}reservation-meta:${reservationId}`], ["settle", actualUnits === null ? "unknown" : actualUnits]);
      if (result !== 1) throw new LedgerFailure("invalid_request");
    },
    async release(requestId) { await execute([lease(requestId), activeKey], ["release", hash(requestId)]); },
    check: (ctx) => checkOrRenew(ctx, "check"),
    renew: (ctx) => checkOrRenew(ctx, "renew"),
  };
}

// Raw addresses never leave this function; trust only a specifically configured peer.
// The configured proxy must overwrite its client-IP header, never append attacker input.
export function hashClientIp(input: { peerIp: string; forwardedFor?: string; trustedProxyIp?: string; secret: string }): string {
  if (!input.secret || !isIP(input.peerIp)) throw new LedgerFailure("invalid_request");
  let selected = input.peerIp;
  if (input.trustedProxyIp === input.peerIp && input.forwardedFor) {
    if (!isIP(input.forwardedFor.trim())) throw new LedgerFailure("invalid_request");
    selected = input.forwardedFor.trim();
  }
  return createHmac("sha256", input.secret).update(ipaddr.process(selected).toNormalizedString()).digest("hex");
}

let sharedLedger: Ledger | undefined;
export async function productionLedger(): Promise<Ledger> {
  if (sharedLedger) return sharedLedger;
  const { config } = await import("@/server/config");
  if (!config.redis.url || !config.redis.token) throw new LedgerFailure("dependency_unavailable");
  const redis = new Redis({ url: config.redis.url, token: config.redis.token, retry: { retries: 0 },
    signal: () => AbortSignal.timeout(2_000), enableAutoPipelining: false });
  sharedLedger = createLedger((lua, keys, args) => redis.eval(lua, keys, args), {
    tavilyAllowanceCredits: config.tavily.verifiedAvailableCredits,
    pool: config.brave.pool, bravePools: allocateBravePools(config.brave.verifiedAvailableCalls),
    aiAllowanceMicrousd: config.ai.allowanceMicrousd, aiProfileCapMicrousd: config.ai.profileCapMicrousd,
  });
  return sharedLedger;
}
