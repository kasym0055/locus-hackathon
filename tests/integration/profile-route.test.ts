import { afterEach, expect, it, vi } from "vitest";
import { createProfileHandler } from "@/server/profile/route-handler";
import { createSessionHandler } from "@/server/profile/session";
import { readEvents } from "@/lib/read-events";
import type { ProfileEvent } from "@/lib/events";
import { fixtureOrigin, fixtureSecret, profileFixture } from "../support/profile-fixture";
vi.mock("next/server", () => ({ after: vi.fn((work: Promise<void>) => { void work.catch(() => {}); }) }));
const waitUntil = (work: Promise<void>) => { void work.catch(() => {}); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function scenario(options: Parameters<typeof profileFixture>[0] = {}) {
  const fixture = await profileFixture(options); cleanup.push(fixture.close); vi.stubGlobal("fetch", fixture.providerFetch);
  const lifecycle: Promise<void>[] = [];
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4", waitUntil: (work: Promise<void>) => { lifecycle.push(work); void work.catch(() => {}); } };
  const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const handler = createProfileHandler({ ...config, services: async () => fixture.services });
  const request = (body: unknown = { query: "Example University", countryHint: "" }, extra: Record<string, string> = {}) => new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { fixture, handler, request, session, lifecycle };
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
  expect(fixture.interpretationContexts).toEqual([{ name: "Example University", campus: "Example City", city: "Example City", country: "Example Country" }]);
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
    const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4", waitUntil };
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
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4", waitUntil };
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
  const { after } = await import("next/server"); vi.mocked(after).mockClear();
  const { POST } = await import("@/app/api/profile/route");
  const response = await POST(new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin }, body: "{}" }));
  expect(response.status).toBe(503); expect((await events(response))[0]).toMatchObject({ type: "fatal", data: { code: "dependency_unavailable" } });
  expect(after).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
});
it.each(["oversizedIdentity", "oversizedWire"] as const)("keeps contiguous framing when %s cannot be serialized", async kind => {
  const fixture = await profileFixture({ [kind]: true }); cleanup.push(fixture.close); vi.stubGlobal("fetch", fixture.providerFetch);
  const config = { origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4", waitUntil };
  const session = await createSessionHandler(config)(new Request(`${fixtureOrigin}/api/session`, { method: "POST", headers: { origin: fixtureOrigin } }));
  const request = new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin, cookie: session.headers.get("set-cookie")!.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ query: "Example University", countryHint: "" }) });
  const seen = await events(await createProfileHandler({ ...config, services: async () => fixture.services })(request));
  expect(seen.at(-1)).toMatchObject({ type: "fatal" });
  expect(seen.map(event => event.seq)).toEqual([1, 2, 3]);
  expect(fixture.stats().providerCalls).toBe(2);
});
it.each([
  ["e75baa8eef521ad1511b5252d2bdb56d7f9c7a67", "e75baa8eef521ad1511b5252d2bdb56d7f9c7a67"],
  [undefined, null], ["invalid-build-value", null],
])("exposes only a valid deployed commit on a pre-admission response: %s", async (commit, expected) => {
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", commit);
  try {
    const { POST } = await import("@/app/api/profile/route");
    const response = await POST(new Request(`${fixtureOrigin}/api/profile`, { method: "POST", headers: { origin: fixtureOrigin }, body: "{}" }));
    expect(response.headers.get("x-locus-commit")).toBe(expected);
    expect(response.status).toBe(503);
    await response.text();
  } finally { vi.unstubAllEnvs(); }
});
it("rejects content types that only start with the JSON media type", async () => {
  const { fixture, handler, request } = await scenario();
  expect((await handler(request(undefined, { "content-type": "application/json-not-valid" }))).status).toBe(400);
  expect(fixture.stats().admitted).toBe(0);
});
it.each([
  { crossOrigin: true }, { imageRedirect: "external" as const }, { imageRedirect: "roundtrip" as const },
])("withholds image without a grant for every observed image origin: %j", async options => {
  const { fixture, handler, request } = await scenario(options);
  const seen = await events(await handler(request()));
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
  expect(fixture.stats().providerCalls).toBe(options.crossOrigin ? 3 : 2);
});
it.each([
  "Example University students visiting Partner University campus in Example City.",
  "Partner University campus in Example City, photographed by Example University students.",
  "Example University and Partner University campus in Example City.",
])("withholds visitor, partner or ambiguous ownership despite a positive AI assessment: %s", async caption => {
  const { handler, request } = await scenario({ caption });
  const seen = await events(await handler(request()));
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it.each([
  [{ crossOrigin: true, imageGrant: true }, "https://third-party.example/campus.png"],
  [{ imageRedirect: "external" as const, imageGrant: true }, "https://third-party.example/campus.png"],
  [{ imageRedirect: "roundtrip" as const, imageGrant: true }, "https://example.edu/final.png"],
] as const)("keeps explicitly permitted image origins and their attribution: %j", async (options, displayUrl) => {
  const { handler, request } = await scenario(options);
  const seen = await events(await handler(request()));
  const card = seen.find(event => event.type === "image");
  expect(card).toMatchObject({ data: { card: { score: 80, displayUrl, source: { policy: { attributionText: expect.stringContaining("Synthetic image host") } } } } });
});
it("treats punctuation in an explicit institution name as literal attribution", async () => {
  const universityName = "Example (Arts) University";
  const { handler, request } = await scenario({ universityName });
  const seen = await events(await handler(request({ query: universityName, countryHint: "" })));
  expect(seen.find(event => event.type === "image")).toMatchObject({ data: { card: { score: 80 } } });
});
it("withholds permission that expires during assessment before emitting a remote card", async () => {
  const startedAt = Date.now(); let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const { fixture, handler, request } = await scenario({ grantExpiresAt: new Date(startedAt + 1000).toISOString(),
      onAssessment: () => { clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 2000); } });
    const seen = await events(await handler(request()));
    expect(fixture.stats().providerCalls).toBe(3);
    expect(seen.filter(event => event.type === "image")).toHaveLength(0);
    expect(seen.at(-1)).toMatchObject({ data: { profile: { warnings: ["policy_unknown"] } } });
  } finally { clock?.mockRestore(); }
});
it.each([
  "Example University campus photographers document Rival University campus in Example City.",
  "Example University campus ambassadors touring Rival University campus in Example City.",
  "Example University campus in Example City. Photographers document Rival University campus.",
])("rejects unsupported continuation of the complete attribution phrase: %s", async caption => {
  const { handler, request } = await scenario({ caption });
  const seen = await events(await handler(request()));
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it("admits a complete explicit campus ownership caption", async () => {
  const { handler, request } = await scenario({ caption: "Example University campus in Example City." });
  const seen = await events(await handler(request()));
  expect(seen.find(event => event.type === "image")).toMatchObject({ data: { card: { score: 80, status: "verified" } } });
});
it.each(["empty", "missing-final", "credentials", "too-many", "non-array"] as const)("rejects inconsistent or malformed image redirect metadata: %s", async redirectMetadata => {
  const { fixture, handler, request } = await scenario({ imageRedirect: "roundtrip", imageGrant: true, redirectMetadata });
  const seen = await events(await handler(request()));
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence", profile: { warnings: ["policy_unknown"] } } });
  expect(fixture.stats().providerCalls).toBe(2);
});
it("admits an ordered redirect chain ending at the inspected final URL", async () => {
  const { handler, request } = await scenario({ imageRedirect: "roundtrip", imageGrant: true });
  const seen = await events(await handler(request()));
  expect(seen.find(event => event.type === "image")).toMatchObject({ data: { card: { score: 80, displayUrl: "https://example.edu/final.png" } } });
});
it("does not discard contradictory prose following a photo credit", async () => {
  const { handler, request } = await scenario({ caption: "Example University campus in Example City. Photo: Synthetic Author. This is actually Rival University campus." });
  const seen = await events(await handler(request()));
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it("withholds oversized decomposed captions whose truncated prefix normalizes to valid ownership", async () => {
  const universityName = "\u1f82".repeat(156), universityPlace = "\u1f82".repeat(170);
  const prefix = `${universityName.normalize("NFD")}'s, ${universityPlace.normalize("NFD")} campus in ${universityPlace.normalize("NFD")}.`;
  expect(prefix).toHaveLength(2000);
  expect(prefix.normalize("NFKC")).toHaveLength(512);
  const { handler, request } = await scenario({ universityName, universityPlace, caption: `${prefix} This is actually Rival University campus.` });
  const seen = await events(await handler(request({ query: universityName, countryHint: "" })));
  expect(seen.find(event => event.type === "identity")).toMatchObject({ data: { university: { name: universityName } } });
  expect(seen.filter(event => event.type === "image")).toHaveLength(0);
  expect(seen.at(-1)).toMatchObject({ data: { state: "insufficient_evidence" } });
});
it.each([false, true])("holds response EOF until lease release completes, fatal=%s", async oversizedIdentity => {
  const gate = deferred();
  const { fixture, handler, request, lifecycle } = await scenario({ oversizedIdentity, release: () => gate.promise });
  let finished = false;
  const reading = events(await handler(request())).then(seen => { finished = true; return seen; });
  try {
    await vi.waitFor(() => expect(fixture.stats().released).toBe(1));
    expect(fixture.stats().releaseCompleted).toBe(0);
    expect(finished).toBe(false);
    expect(lifecycle).toHaveLength(1);
  } finally { gate.resolve(); await reading; }
  const seen = await reading;
  expect(seen.filter(event => event.type === "final" || event.type === "fatal")).toHaveLength(1);
  expect(seen.at(-1)?.type).toBe(oversizedIdentity ? "fatal" : "final");
  await lifecycle[0];
  expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 1 });
});
it.each(["stream", "request"])("tracks in-flight %s cancellation until its single delayed release completes", async kind => {
  const gate = deferred();
  const { fixture, handler, request, lifecycle } = await scenario({ hangAi: true, release: () => gate.promise });
  const disconnect = new AbortController();
  const response = await handler(new Request(request(), { signal: disconnect.signal })); const reader = response.body!.getReader();
  try {
    await vi.waitFor(() => expect(fixture.stats().providerCalls).toBe(3));
    if (kind === "stream") await reader.cancel(); else disconnect.abort();
    await vi.waitFor(() => expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 0, abortedAi: true }));
    expect(lifecycle).toHaveLength(1);
    let settled = false; void lifecycle[0].then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
  } finally { gate.resolve(); await Promise.all(lifecycle); await reader.cancel(); reader.releaseLock(); }
  expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 1 });
});
it("bounds and reports stalled cancellation release through the registered lifecycle", async () => {
  const { fixture, handler, request, lifecycle } = await scenario({ hangAi: true, release: () => new Promise<void>(() => {}) });
  const reader = (await handler(request())).body!.getReader();
  await vi.waitFor(() => expect(fixture.stats().providerCalls).toBe(3));
  await reader.cancel(); reader.releaseLock();
  expect(lifecycle).toHaveLength(1);
  await expect(lifecycle[0]).rejects.toMatchObject({ code: "dependency_unavailable" });
  expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 0, abortedAi: true });
});
it("reports release failure as a stream error without a second terminal frame", async () => {
  const { fixture, handler, request, lifecycle } = await scenario({ release: async () => { throw new Error("fixture release failed"); } });
  const seen: ProfileEvent[] = [];
  await expect(readEvents((await handler(request())).body!, event => seen.push(event), new AbortController().signal)).rejects.toThrow("protocol_error");
  expect(seen.filter(event => event.type === "final" || event.type === "fatal").length).toBeLessThanOrEqual(1);
  expect(lifecycle).toHaveLength(1);
  await expect(lifecycle[0]).rejects.toMatchObject({ code: "dependency_unavailable" });
  expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 0 });
});
it("tracks disconnect during admission and releases once before a pre-stream failure response", async () => {
  const admissionGate = deferred(), releaseGate = deferred();
  const { fixture, handler, request, lifecycle } = await scenario({ release: () => releaseGate.promise });
  const admit = fixture.services.ledger.admit;
  fixture.services.ledger.admit = async ctx => { const result = await admit(ctx); await admissionGate.promise; return result; };
  const disconnect = new AbortController(); let finished = false;
  const response = handler(new Request(request(), { signal: disconnect.signal })).then(value => { finished = true; return value; });
  try {
    await vi.waitFor(() => expect(fixture.stats().admitted).toBe(1));
    expect(lifecycle).toHaveLength(1);
    disconnect.abort(); admissionGate.resolve();
    await vi.waitFor(() => expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 0 }));
    expect(finished).toBe(false);
  } finally { admissionGate.resolve(); releaseGate.resolve(); await response; await lifecycle[0]; }
  expect((await response).status).toBe(503);
  expect(fixture.stats()).toMatchObject({ released: 1, releaseCompleted: 1, providerCalls: 0 });
});
it("fails before admission if the host cannot register the request lifecycle", async () => {
  const { fixture, request } = await scenario();
  const response = await createProfileHandler({ origin: fixtureOrigin, secret: fixtureSecret, clientIp: () => "198.51.100.4",
    services: async () => fixture.services, waitUntil: () => { throw new Error("unsupported host lifecycle"); } })(request());
  expect(response.status).toBe(503);
  expect(fixture.stats()).toMatchObject({ admitted: 0, released: 0, providerCalls: 0 });
});
