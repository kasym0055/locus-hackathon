import "server-only";

import { z } from "zod";

const booleanSetting = z.enum(["true", "false"]).transform((value) => value === "true");

const environment = z.object({
  AI_MODEL: z.string().default("gpt-5.6-luna"),
  AI_ALLOWANCE_MICROUSD: z.coerce.number().int().positive().default(4_000_000),
  AI_PROFILE_CAP_MICROUSD: z.coerce.number().int().positive().default(20_000),
  BRAVE_PAID_OVERAGE: booleanSetting.default(false),
  BRAVE_API_KEY: z.string().default(""),
  // No credit balance has been verified until the operator supplies it.
  BRAVE_VERIFIED_AVAILABLE_CALLS: z.coerce.number().int().nonnegative().max(1_000_000).default(0),
  BRAVE_POOL: z.enum(["development", "acceptance", "judging"]).default("development"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal("")),
  UPSTASH_REDIS_REST_TOKEN: z.string().default(""),
  TRUSTED_PROXY_IP: z.string().default(""),
  CAPABILITY_PROBE_ENABLED: booleanSetting.default(false),
  CAPABILITY_PROBE_TOKEN: z.string().default(""),
  CAPABILITY_PROBE_ENDPOINT: z.string().url().optional().or(z.literal("")),
  CACHE_READ_ENABLED: booleanSetting.default(true),
});

const parsed = environment.parse(process.env);
if (parsed.BRAVE_PAID_OVERAGE) throw new Error("Paid Brave overage is not supported");

export const config = Object.freeze({
  ai: Object.freeze({
    model: parsed.AI_MODEL,
    allowanceMicrousd: parsed.AI_ALLOWANCE_MICROUSD,
    profileCapMicrousd: parsed.AI_PROFILE_CAP_MICROUSD,
  }),
  bravePaidOverage: parsed.BRAVE_PAID_OVERAGE,
  brave: Object.freeze({ apiKey: parsed.BRAVE_API_KEY, verifiedAvailableCalls: parsed.BRAVE_VERIFIED_AVAILABLE_CALLS, pool: parsed.BRAVE_POOL }),
  redis: Object.freeze({ url: parsed.UPSTASH_REDIS_REST_URL || undefined, token: parsed.UPSTASH_REDIS_REST_TOKEN }),
  trustedProxyIp: parsed.TRUSTED_PROXY_IP || undefined,
  cacheReadEnabled: parsed.CACHE_READ_ENABLED,
  capabilityProbe: Object.freeze({
    enabled: parsed.CAPABILITY_PROBE_ENABLED,
    endpoint: parsed.CAPABILITY_PROBE_ENDPOINT || undefined,
    token: parsed.CAPABILITY_PROBE_TOKEN,
  }),
});
