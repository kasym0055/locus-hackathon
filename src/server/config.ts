import "server-only";

import { z } from "zod";

const booleanSetting = z.enum(["true", "false"]).transform((value) => value === "true");

const environment = z.object({
  AI_MODEL: z.string().default("gpt-5.6-luna"),
  AI_ALLOWANCE_MICROUSD: z.coerce.number().int().positive().default(4_000_000),
  AI_PROFILE_CAP_MICROUSD: z.coerce.number().int().positive().default(20_000),
  BRAVE_PAID_OVERAGE: booleanSetting.default(false),
  CAPABILITY_PROBE_ENABLED: booleanSetting.default(false),
  CAPABILITY_PROBE_TOKEN: z.string().default(""),
  CAPABILITY_PROBE_ENDPOINT: z.string().url().optional().or(z.literal("")),
  CACHE_READ_ENABLED: booleanSetting.default(true),
});

const parsed = environment.parse(process.env);

export const config = Object.freeze({
  ai: Object.freeze({
    model: parsed.AI_MODEL,
    allowanceMicrousd: parsed.AI_ALLOWANCE_MICROUSD,
    profileCapMicrousd: parsed.AI_PROFILE_CAP_MICROUSD,
  }),
  bravePaidOverage: parsed.BRAVE_PAID_OVERAGE,
  cacheReadEnabled: parsed.CACHE_READ_ENABLED,
  capabilityProbe: Object.freeze({
    enabled: parsed.CAPABILITY_PROBE_ENABLED,
    endpoint: parsed.CAPABILITY_PROBE_ENDPOINT || undefined,
    token: parsed.CAPABILITY_PROBE_TOKEN,
  }),
});
