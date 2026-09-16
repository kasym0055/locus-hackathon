import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedRedis = vi.hoisted(() => new Map<string, unknown>());
const lifecycle = vi.hoisted(() => [] as Promise<unknown>[]);
const redisWrites = vi.hoisted(() => [] as Array<{ key: string; value: unknown; options: unknown }>);

vi.mock("@upstash/redis", () => ({
  Redis: class {
    async get<T>(key: string): Promise<T | null> {
      return (sharedRedis.get(key) as T | undefined) ?? null;
    }

    async set<T>(key: string, value: T, options?: unknown): Promise<"OK"> {
      redisWrites.push({ key, value: structuredClone(value), options });
      sharedRedis.set(key, structuredClone(value));
      return "OK";
    }

    async del(key: string): Promise<number> {
      return sharedRedis.delete(key) ? 1 : 0;
    }
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  after(work: Promise<unknown>) {
    lifecycle.push(work);
    void work.catch(() => {});
  },
}));

const token = "fixture-capability-token";
const origin = "https://probe.example";

type CapabilityRoute = typeof import("@/app/api/capability/route");
type CancellationEvidence = {
  cancelled: boolean;
  source?: "request" | "stream";
  cleanupComplete: boolean;
  waitTimersCleared: number;
  outboundAborted: boolean;
};

async function isolatedInstance(): Promise<CapabilityRoute> {
  vi.resetModules();
  return import("@/app/api/capability/route");
}

function authorizedRequest(path = "/api/capability", runId?: string): Request {
  return new Request(`${origin}${path}`, {
    headers: {
      "x-capability-probe-token": token,
      ...(runId ? { "x-capability-probe-run-id": runId } : {}),
    },
  });
}

async function cancelAfterFirstFrame(route: CapabilityRoute, runId: string): Promise<void> {
  const response = await route.GET(authorizedRequest("/api/capability", runId));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"frame":0');
  await reader.cancel();
}

async function readStatus(route: CapabilityRoute, runId: string): Promise<{ status: number; evidence: CancellationEvidence }> {
  const response = await route.GET(authorizedRequest(`/api/capability?status=${runId}`));
  expect(response.headers.get("x-capability-state-backend")).toBe("redis");
  return { status: response.status, evidence: await response.json() as CancellationEvidence };
}

async function waitForCleanup(route: CapabilityRoute, runId: string): Promise<CancellationEvidence> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await readStatus(route, runId);
    if (result.status === 200 && result.evidence.cleanupComplete) return result.evidence;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("cancellation cleanup was not observable");
}

describe("capability cancellation evidence", () => {
  beforeEach(() => {
    vi.stubEnv("CAPABILITY_PROBE_ENABLED", "true");
    vi.stubEnv("CAPABILITY_PROBE_TOKEN", token);
    vi.stubEnv("CAPABILITY_PROBE_ENDPOINT", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fixture-redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fixture-redis-token");
    sharedRedis.clear();
    lifecycle.length = 0;
    redisWrites.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fires cancellation and records completed cleanup in the serving instance", async () => {
    const route = await isolatedInstance();
    const runId = "11111111-1111-4111-8111-111111111111";

    await cancelAfterFirstFrame(route, runId);

    await expect(waitForCleanup(route, runId)).resolves.toMatchObject({
      cancelled: true,
      source: "stream",
      cleanupComplete: true,
    });
  });

  it("makes cancellation evidence observable from a separate server instance", async () => {
    const writer = await isolatedInstance();
    const runId = "22222222-2222-4222-8222-222222222222";
    await cancelAfterFirstFrame(writer, runId);

    const reader = await isolatedInstance();

    await expect(waitForCleanup(reader, runId)).resolves.toMatchObject({
      cancelled: true,
      source: "stream",
      cleanupComplete: true,
    });
    expect(redisWrites.length).toBeGreaterThan(0);
    expect(redisWrites.length).toBeLessThanOrEqual(4);
    expect(lifecycle).toHaveLength(1);
    await expect(lifecycle[0]).resolves.toBeUndefined();
    expect(redisWrites.every(write => write.key === `locus:capability-probe:v1:cancellation:${runId}`)).toBe(true);
    expect(redisWrites.every(write => JSON.stringify(write.options) === JSON.stringify({ ex: 60 }))).toBe(true);
    expect(redisWrites.every(write => Object.keys(write.value as object).sort().join(",")
      === "cancelled,cleanupComplete,outboundAborted,source,updatedAt,waitTimersCleared")).toBe(true);
    expect(sharedRedis.size).toBe(1);
  });

  it("keeps completed evidence readable for a retry until its Redis TTL expires", async () => {
    const writer = await isolatedInstance();
    const runId = "33333333-3333-4333-8333-333333333333";
    await cancelAfterFirstFrame(writer, runId);

    const firstReader = await isolatedInstance();
    await expect(waitForCleanup(firstReader, runId)).resolves.toMatchObject({ cleanupComplete: true });

    const retryReader = await isolatedInstance();
    await expect(readStatus(retryReader, runId)).resolves.toMatchObject({
      status: 200,
      evidence: { cleanupComplete: true },
    });
  });
});
