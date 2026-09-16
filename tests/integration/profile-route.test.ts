import { afterEach, expect, it, vi } from "vitest";
import { createProfileHandler } from "@/server/profile/route-handler";
import { createSessionHandler } from "@/server/profile/session";
import { readEvents } from "@/lib/read-events";
import type { ProfileEvent } from "@/lib/events";
import { fixtureOrigin, fixtureSecret, profileFixture } from "../support/profile-fixture";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function scenario(options: Parameters<typeof profileFixture>[0] = {}) {
  const fixture = await profileFixture(options); cleanup.push(fixture.close); vi.stubGlobal("fetch", fixture.providerFetch);
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4" };
  const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const handler = createProfileHandler({ ...config, services: async () => fixture.services });
  const request = (body: unknown = { query: "Example University", countryHint: "" }, extra: Record<string, string> = {}) => new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { fixture, handler, request, session };
}
async function events(response: Response) { const seen: ProfileEvent[] = []; await readEvents(response.body!, event => seen.push(event), new AbortController().signal); return seen; }
it("streams a real pipeline through external fixtures to a source-linked score-80 card", async () => {
  const { fixture, handler, request, session } = await scenario();
  expect(session.headers.get("set-cookie")).toMatch(/HttpOnly.*Secure.*SameSite=Lax/);
  const response = await handler(request()); const seen = await events(response);
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(seen.filter(e => ["final", "fatal"].includes(e.type))).toHaveLength(1);
  expect(seen.find(e => e.type === "image")).toMatchObject({ data: { card: { score: 80, status: "verified", displayUrl: "https://example.edu/campus.png", source: { url: "https://example.edu/" } } } });
  expect(seen.at(-1)).toMatchObject({ type: "final", data: { state: "partial", profile: { description: [] } } });
  expect(JSON.stringify(seen)).not.toMatch(/untrustedPublisherEvidence|base64|excerpt|"bytes"|thumbnail/);
  expect(fixture.stats()).toMatchObject({ admitted: 1, released: 1, providerCalls: 3 });
  expect(fixture.contexts[0].deadlineAt - fixture.contexts[0].startedAt).toBe(27000);
});
it("rejects the changed photo location without inventing a fallback", async () => {
  const { handler, request } = await scenario({ conflict: true }); const seen = await events(await handler(request()));
  expect(seen.filter(e => e.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it("keeps missing publisher display permission honest", async () => {
  const { handler, request } = await scenario({ permit: false }); const seen = await events(await handler(request()));
  expect(seen.filter(e => e.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it.each([{}, { query: "a" }, { query: "Example University", countryHint: "", selectionToken: "forged" }, { query: "x".repeat(2200), countryHint: "" }])("rejects invalid input before admission or providers", async body => {
  const { fixture, handler, request } = await scenario(); const response = await handler(request(body));
  expect(response.status).toBe(400); expect((await events(response))[0]).toMatchObject({ type: "fatal", data: { code: "invalid_request" } });
  expect(fixture.stats()).toMatchObject({ admitted: 0, providerCalls: 0 });
});
it("rejects foreign origins and tampered sessions before providers", async () => {
  const { fixture, handler, request } = await scenario();
  for (const headers of [{ origin: "https://evil.example" }, { cookie: "vup_session=forged" }] as Record<string, string>[]) expect((await handler(request(undefined, headers))).status).toBe(400);
  expect(fixture.stats()).toMatchObject({ admitted: 0, providerCalls: 0 });
});
it("rejects busy admission with Retry-After and no providers", async () => {
  const { fixture, handler, request } = await scenario({ busy: true }); const response = await handler(request());
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("2");
  expect((await events(response))[0]).toMatchObject({ type: "fatal", data: { code: "busy" } });
  expect(fixture.stats()).toMatchObject({ admitted: 1, released: 0, providerCalls: 0 });
});
it("fails closed without server configuration", async () => {
  const response = await createSessionHandler({})(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  expect(response.status).toBe(503);
});

it("does not wait past the receipt deadline for an unfinished body", async () => {
  vi.useFakeTimers(); let bodyCancelled = false;
  try {
    const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4" };
    const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const request = new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie, "content-type": "application/json" },
      body: new ReadableStream({ cancel() { bodyCancelled = true; } }), duplex: "half" } as RequestInit);
    let servicesCalled = false;
    const response = createProfileHandler({ ...config, services: async () => { servicesCalled = true; throw new Error(); } })(request);
    await vi.advanceTimersByTimeAsync(27000);
    expect((await response).status).toBe(503); expect(servicesCalled).toBe(false); expect(bodyCancelled).toBe(true);
  } finally { vi.useRealTimers(); }
});
it("retains an existing signed session rather than refreshing its rate-limit identity", async () => {
  const handler = createSessionHandler({ origin: fixtureOrigin, secret: fixtureSecret });
  const first = await handler(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const response = await handler(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin, cookie: first.headers.get("set-cookie")!.split(";")[0] } }));
  expect(response.status).toBe(204); expect(response.headers.get("set-cookie")).toBeNull();
});
it("cancels model transport and releases admission on client disconnect", async () => {
  const fixture = await profileFixture({ hangAi: true }); cleanup.push(fixture.close); vi.stubGlobal("fetch", fixture.providerFetch);
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4" };
  const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const request = new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie: session.headers.get("set-cookie")!.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ query: "Example University", countryHint: "" }) });
  const response = await createProfileHandler({ ...config, services: async () => fixture.services })(request);
  const reader = response.body!.getReader();
  while (true) { const { value } = await reader.read(); if (new TextDecoder().decode(value).includes('"assessing"')) break; }
  await vi.waitFor(() => expect(fixture.stats().providerCalls).toBe(3));
  await reader.cancel();
  await vi.waitFor(() => expect(fixture.stats()).toMatchObject({ released: 1, abortedAi: true }));
});
it("uses the production route's unavailable response when configuration is absent", async () => {
  const { POST } = await import("@/app/api/profile/route");
  const response = await POST(new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin }, body: "{}" }));
  expect(response.status).toBe(503); expect((await events(response))[0]).toMatchObject({ type: "fatal", data: { code: "dependency_unavailable" } });
});
it.each(["oversizedIdentity", "oversizedWire"] as const)("keeps contiguous framing when %s cannot be serialized", async kind => {
  const fixture = await profileFixture({ [kind]: true }); cleanup.push(fixture.close); vi.stubGlobal("fetch", fixture.providerFetch);
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4" };
  const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const request = new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie: session.headers.get("set-cookie")!.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ query: "Example University", countryHint: "" }) });
  const seen = await events(await createProfileHandler({ ...config, services: async () => fixture.services })(request));
  expect(seen.at(-1)).toMatchObject({ type: "fatal" });
  expect(seen.map(event => event.seq)).toEqual([1, 2, 3]);
  expect(fixture.stats().providerCalls).toBe(2);
});
it("rejects content types that only start with the JSON media type", async () => {
  const { fixture, handler, request } = await scenario();
  expect((await handler(request(undefined, { "content-type": "application/json-not-valid" }))).status).toBe(400);
  expect(fixture.stats().admitted).toBe(0);
});
