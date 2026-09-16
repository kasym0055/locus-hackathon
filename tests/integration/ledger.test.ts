import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateBravePools, createLedger, hashClientIp, type EvalScript } from "@/server/usage/ledger";
import { contextFixture } from "../support/fixtures";

it.each([
  [0, { development: 0, acceptance: 0, judging: 0 }],
  [150, { development: 0, acceptance: 0, judging: 150 }],
  [600, { development: 300, acceptance: 100, judging: 200 }],
  [1000, { development: 600, acceptance: 200, judging: 200 }],
  [5000, { development: 600, acceptance: 200, judging: 200 }],
])("protects the judging allocation at verified balance %s", (balance, pools) => {
  expect(allocateBravePools(balance as number)).toEqual(pools);
});
it("fails closed when the shared store is down", async () => {
  const ledger = createLedger(async () => { throw new Error("store offline"); });
  await expect(ledger.admit(contextFixture())).rejects.toMatchObject({ code: "dependency_unavailable" });
  await expect(ledger.reserve(contextFixture(), "brave", 1)).rejects.toMatchObject({ code: "dependency_unavailable" });
});
it("HMACs the peer address and ignores forwarding from an untrusted proxy", () => {
  const secret = "synthetic-test-secret";
  const direct = hashClientIp({ peerIp: "192.0.2.2", forwardedFor: "198.51.100.2", secret });
  expect(direct).toBe(hashClientIp({ peerIp: "192.0.2.2", secret }));
  expect(direct).toMatch(/^[a-f0-9]{64}$/);
  expect(direct).not.toBe(hashClientIp({ peerIp: "192.0.2.2", forwardedFor: "198.51.100.2", trustedProxyIp: "192.0.2.2", secret }));
});

// Deliberately no in-memory Lua emulator. CI/operator supplies its own isolated Redis.
describe.skipIf(!process.env.REDIS_TEST_URL)("identical production Lua on real Redis", () => {
  const namespace = `test-${randomUUID()}`;
  const client = createClient({ url: process.env.REDIS_TEST_URL, socket: { reconnectStrategy: false } });
  client.on("error", () => {});
  const calls: Array<{ script: string; keys: string[]; args: string[] }> = [];
  const evaluate: EvalScript = async (script, keys, args) => { calls.push({ script, keys, args }); return client.eval(script, { keys, arguments: args }); };
  const ledger = () => createLedger(evaluate, { namespace, bravePools: { development: 600, acceptance: 200, judging: 200 }, pool: "development" });
  const context = () => ({ ...contextFixture(), requestId: randomUUID(), sessionId: randomUUID(), ipHash: randomUUID() });
  beforeAll(async () => { await client.connect(); });
  afterAll(async () => {
    if (client.isOpen) {
      for await (const keys of client.scanIterator({ MATCH: `{${namespace}}:*`, COUNT: 100 })) {
        if (keys.length) await client.del(keys);
      }
      await client.quit();
    }
  });
  it("admits only three of four concurrent pipelines across ledger instances", async () => {
    const contexts = Array.from({ length: 4 }, context);
    const results = await Promise.all(contexts.map((ctx) => ledger().admit(ctx)));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.find((result) => !result.allowed)?.retryAfterSeconds).toBeGreaterThan(0);
    await Promise.all(contexts.map((ctx) => ledger().release(ctx.requestId)));
  });
  it("replays the identical reservation ID without double charging and settles once", async () => {
    const ctx = context(); const instance = ledger(); await instance.admit(ctx);
    const reservation = await instance.reserve(ctx, "ai", 20_000);
    const command = calls.at(-1)!;
    await evaluate(command.script, command.keys, command.args);
    await instance.settle(reservation, 10_000);
    await instance.settle(reservation, 10_000);
    await expect(instance.reserve(ctx, "ai", 10_000)).resolves.toBeTypeOf("string");
    await expect(instance.reserve(ctx, "ai", 1)).rejects.toMatchObject({ code: "budget_exhausted" });
    await instance.release(ctx.requestId);
  });
  it("retains unknown cost and rejects an over-cap reservation without a partial increment", async () => {
    const ctx = context(); const instance = ledger(); await instance.admit(ctx);
    await expect(instance.reserve(ctx, "ai", 20_001)).rejects.toMatchObject({ code: "budget_exhausted" });
    const reservation = await instance.reserve(ctx, "ai", 20_000);
    await instance.settle(reservation, null);
    await expect(instance.reserve(ctx, "ai", 1)).rejects.toMatchObject({ code: "budget_exhausted" });
    await instance.release(ctx.requestId);
  });
  it("allows one active request per session and ten successive searches", async () => {
    const session = randomUUID(); const instance = ledger();
    for (let index = 0; index < 10; index++) {
      const ctx = { ...context(), sessionId: session };
      expect((await instance.admit(ctx)).allowed).toBe(true);
      expect((await instance.admit({ ...context(), sessionId: session })).allowed).toBe(false);
      await instance.release(ctx.requestId);
    }
    const denied = await instance.admit({ ...context(), sessionId: session });
    expect(denied.allowed).toBe(false); expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
  it("blocks spending after release and never refunds unknown reservations on release", async () => {
    const ctx = context(); const instance = ledger(); await instance.admit(ctx);
    const id = await instance.reserve(ctx, "brave", 1);
    await instance.settle(id, null); await instance.release(ctx.requestId);
    await expect(instance.reserve(ctx, "brave", 1)).rejects.toMatchObject({ code: "busy" });
    await expect(instance.renew(ctx)).rejects.toMatchObject({ code: "busy" });
    expect(await client.get(`{${namespace}}:reservation:${id}`)).toBe("1");
  });
  it("honors the IP rolling guard while allowing separate sessions on that IP", async () => {
    const instance = ledger(); const ipHash = randomUUID();
    for (let index = 0; index < 120; index++) {
      const ctx = { ...context(), ipHash }; expect((await instance.admit(ctx)).allowed).toBe(true); await instance.release(ctx.requestId);
    }
    const denied = await instance.admit({ ...context(), ipHash });
    expect(denied.allowed).toBe(false); expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
  it("expires stale active leases atomically and does not restore their spending", async () => {
    const contexts = Array.from({ length: 3 }, context); const instance = ledger();
    for (const ctx of contexts) { await instance.admit(ctx); await instance.reserve(ctx, "brave", 1); }
    const activeKey = `{${namespace}}:active`;
    const ids = await client.zRange(activeKey, 0, -1);
    await client.zAdd(activeKey, ids.map((value) => ({ score: 0, value })));
    const newcomer = context(); expect((await instance.admit(newcomer)).allowed).toBe(true);
    await expect(instance.reserve(contexts[0], "brave", 1)).rejects.toMatchObject({ code: "busy" });
    await expect(instance.renew(contexts[0])).rejects.toMatchObject({ code: "busy" });
    for (const ctx of contexts) await instance.release(ctx.requestId);
    await instance.release(newcomer.requestId);
  });
  it("protects separate Brave pools and enforces the per-request ten-call cap", async () => {
    const poolNamespace = `${namespace}-pools`;
    const options = { namespace: poolNamespace, bravePools: { development: 1, acceptance: 1, judging: 200 } };
    const development = createLedger(evaluate, { ...options, pool: "development" });
    const acceptance = createLedger(evaluate, { ...options, pool: "acceptance" });
    const ctx = context(); await development.admit(ctx);
    await development.reserve(ctx, "brave", 1);
    await expect(development.reserve(ctx, "brave", 1)).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(acceptance.reserve(ctx, "brave", 1)).resolves.toBeTypeOf("string");
    await development.release(ctx.requestId);
    const request = context(); const regular = ledger(); await regular.admit(request);
    for (let index = 0; index < 10; index++) await regular.reserve(request, "brave", 1);
    await expect(regular.reserve(request, "brave", 1)).rejects.toMatchObject({ code: "budget_exhausted" });
    await regular.release(request.requestId);
    for await (const keys of client.scanIterator({ MATCH: `{${poolNamespace}}:*`, COUNT: 100 })) if (keys.length) await client.del(keys);
  });
});
