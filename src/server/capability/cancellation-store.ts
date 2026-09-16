import { Redis } from "@upstash/redis";
import { z } from "zod";

import { config } from "@/server/config";

const KEY_PREFIX = "locus:capability-probe:v1:cancellation:";
const RECORD_TTL_SECONDS = 60;
const runIdPattern = /^[a-f0-9-]{36}$/i;
const recordSchema = z.strictObject({
  cancelled: z.literal(true),
  source: z.enum(["request", "stream"]),
  cleanupComplete: z.boolean(),
  waitTimersCleared: z.number().int().nonnegative().max(8),
  outboundAborted: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

export type CancellationRecord = z.infer<typeof recordSchema>;

export interface CapabilityCancellationStore {
  read(runId: string): Promise<CancellationRecord | null>;
  write(runId: string, record: CancellationRecord): Promise<void>;
}

type RedisCommands = Pick<Redis, "del" | "get" | "set">;

export class CapabilityStoreFailure extends Error {
  constructor() {
    super("Capability cancellation evidence is unavailable");
    this.name = "CapabilityStoreFailure";
  }
}

function key(runId: string): string {
  if (!runIdPattern.test(runId)) throw new CapabilityStoreFailure();
  return `${KEY_PREFIX}${runId}`;
}

export function createCapabilityCancellationStore(redis: RedisCommands): CapabilityCancellationStore {
  return {
    async read(runId) {
      try {
        const redisKey = key(runId);
        const value = await redis.get<unknown>(redisKey);
        if (value === null) return null;
        const parsed = recordSchema.safeParse(value);
        if (!parsed.success) {
          await redis.del(redisKey);
          throw new CapabilityStoreFailure();
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof CapabilityStoreFailure) throw error;
        throw new CapabilityStoreFailure();
      }
    },
    async write(runId, record) {
      try {
        const parsed = recordSchema.parse(record);
        const result = await redis.set(key(runId), parsed, { ex: RECORD_TTL_SECONDS });
        if (result !== "OK") throw new CapabilityStoreFailure();
      } catch (error) {
        if (error instanceof CapabilityStoreFailure) throw error;
        throw new CapabilityStoreFailure();
      }
    },
  };
}

let sharedStore: CapabilityCancellationStore | undefined;

export function productionCapabilityCancellationStore(): CapabilityCancellationStore {
  if (sharedStore) return sharedStore;
  if (!config.redis.url || !config.redis.token) throw new CapabilityStoreFailure();
  const redis = new Redis({
    url: config.redis.url,
    token: config.redis.token,
    retry: { retries: 0 },
    signal: () => AbortSignal.timeout(2_000),
    enableAutoPipelining: false,
  });
  sharedStore = createCapabilityCancellationStore(redis);
  return sharedStore;
}
