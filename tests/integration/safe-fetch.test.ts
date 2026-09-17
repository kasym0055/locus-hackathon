import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createSafeFetcher, type FetchDependencies } from "@/server/fetch/safe-fetch";
import { createAccessPolicy } from "@/server/fetch/access-policy";
import { contextFixture, restrictiveRobots, transportFixture } from "../support/fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
const publicAnswer = async () => [{ address: "93.184.216.34", family: 4 }];
const configured = { contactUrl: "https://visual-profile-project.org/contact", resolve: publicAnswer };
async function setup(handler: Parameters<typeof transportFixture>[0], overrides: FetchDependencies = {}) {
  const transport = await transportFixture(handler);
  cleanup.push(transport.close);
  return { ...transport, ...createSafeFetcher({ ...configured, connect: transport.connector, ...overrides }) };
}
const ordinary: Parameters<typeof transportFixture>[0] = (request, response) => {
  if (request.url === "/robots.txt") { response.writeHead(404); response.end(); }
  else { response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Publisher</h1>"); }
};

describe("publisher access denial diagnostics", () => {
  it.each([
    { mode: "robots", source: "robots_policy", status: undefined },
    { mode: "status", source: "http_status", status: 403 },
    { mode: "retry", source: "retry_after", status: 429 },
    { mode: "header", source: "x_robots_tag", status: 200 },
    { mode: "meta", source: "meta_robots", status: 200 },
  ])("identifies $mode denial without exposing publisher data", async ({ mode, source, status }) => {
    const reports: unknown[] = [];
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") {
        if (mode !== "robots") return ordinary(request, response);
        response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nDisallow: /\n"); return;
      }
      response.writeHead(status!, { "content-type": "text/html", "set-cookie": "private-cookie",
        ...(mode === "retry" ? { "retry-after": "120" } : {}),
        ...(mode === "header" ? { "x-robots-tag": "noimageai" } : {}) });
      response.end(mode === "meta" ? '<meta name="robots" content="noai">private-body' : "private-body");
    }, { onAccessDenied: report => { reports.push(report); } });
    const ctx = { ...contextFixture(), publisherPhase: "official_corroboration" as const };
    const failure = await client.safeFetch("http://publisher.org/private-path?key=private-query", "html", ctx).catch(error => error);
    expect(failure.code).toBe("access_denied");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ event: "publisher_access_denied", requestId: ctx.requestId,
      phase: "official_corroboration", kind: "html", hop: 0, origin: 1, target: 1,
      source, ...(status === undefined ? {} : { status }), retryAtPresent: mode === "retry",
      ...(mode === "retry" ? { retryAfterMs: expect.any(Number) } : {}), elapsedMs: expect.any(Number) });
    if (mode === "retry") {
      expect(failure.retryAt).toBeGreaterThan(Date.now());
      expect(reports[0]).toMatchObject({ retryAfterMs: expect.any(Number) });
    }
    expect(JSON.stringify(reports)).not.toMatch(/publisher\.org|private-|https?:|cookie|authorization|bytes/i);
    expect(client.requests.map(request => request.path)).toEqual(mode === "robots"
      ? ["/robots.txt"] : ["/robots.txt", "/private-path?key=private-query"]);
  });
  it("reports the denied redirect destination and reuses request-local target IDs", async () => {
    const reports: unknown[] = [];
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(request.url === "/start" ? 302 : 403, { location: "http://destination.org/denied" }); response.end();
    }, { onAccessDenied: report => { reports.push(report); } });
    const ctx = contextFixture();
    await expect(client.safeFetch("http://publisher.org/start", "image", ctx)).rejects.toMatchObject({ code: "access_denied" });
    await expect(client.safeFetch("http://destination.org/denied", "image", ctx)).rejects.toMatchObject({ code: "access_denied" });
    expect(reports).toMatchObject([
      { kind: "image", hop: 1, origin: 1, target: 1, source: "http_status", status: 403 },
      { kind: "image", hop: 0, origin: 1, target: 1, source: "http_status", status: 403 },
    ]);
  });
  it("logs robots Retry-After and the blocked content without dispatching content", async () => {
    const reports: unknown[] = [];
    const client = await setup((_, response) => { response.writeHead(503, { "retry-after": "60" }); response.end(); },
      { onAccessDenied: report => { reports.push(report); } });
    expect(await client.checkAccess("http://publisher.org/page", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
    expect(reports).toMatchObject([
      { kind: "robots", status: 503, source: "retry_after", retryAtPresent: true },
      { kind: "robots", source: "robots_policy", retryAtPresent: true },
    ]);
    expect(client.requests.map(request => request.path)).toEqual(["/robots.txt"]);
  });
  it("reports a direct access-policy check denial while preserving its result", async () => {
    const reports: unknown[] = [];
    const client = await setup((_, response) => {
      response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nDisallow: /\n");
    }, { onAccessDenied: report => { reports.push(report); } });
    const ctx = contextFixture();
    expect(await client.checkAccess("http://publisher.org/page", ctx)).toEqual({ allowed: false, reason: "access_denied" });
    expect(reports).toMatchObject([{ requestId: ctx.requestId, source: "robots_policy", hop: 0 }]);
    expect(client.requests.map(request => request.path)).toEqual(["/robots.txt"]);
  });
  it("leaves dispatch budgets and budget diagnostics intact when access logging is enabled", async () => {
    const denied: unknown[] = [], budgets: unknown[] = [];
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(403); response.end();
    }, { onAccessDenied: report => { denied.push(report); }, onBudgetExhausted: report => budgets.push(report) });
    const ctx = contextFixture();
    for (let index = 0; index < 12; index++) {
      await expect(client.safeFetch("http://publisher.org/denied", "html", ctx)).rejects.toMatchObject({ code: "access_denied" });
    }
    await expect(client.safeFetch("http://publisher.org/denied", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(denied).toHaveLength(12);
    expect(budgets).toMatchObject([{ exhausted: "html_attempts", limit: 12, dispatched: { html: 12, image: 0, robots: 1 } }]);
    expect(client.requests).toHaveLength(13);
  });
  it.each([false, true])("bounds reports per request even when the sink fails (async=%s)", async asyncSink => {
    let calls = 0;
    const client = await setup(ordinary, { publisherRules: new Map([["http://publisher.org", { crawl: "deny" }]]),
      onAccessDenied: () => { calls++; if (asyncSink) return Promise.reject(new Error("sink failed")); throw new Error("sink failed"); } });
    const ctx = contextFixture();
    for (let index = 0; index < 20; index++) {
      await expect(client.safeFetch(`http://publisher.org/${index}`, "html", ctx)).rejects.toMatchObject({ code: "access_denied" });
    }
    expect(calls).toBe(16);
    await expect(client.safeFetch("http://publisher.org/new-request", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(calls).toBe(17);
    await expect(client.safeFetch("http://allowed.org/page", "html", ctx)).resolves.toMatchObject({ status: 200 });
    expect(client.requests.map(request => request.host)).toEqual(["allowed.org", "allowed.org"]);
  });
});

describe("publisher budget diagnostics", () => {
  it("reports the first blocked redirect and exact dispatch sequence across pipeline phases without retaining URLs", async () => {
    const reports: unknown[] = [];
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt" || request.url === "/hop-2") return ordinary(request, response);
      response.writeHead(302, { location: request.url === "/hop-0" ? "/hop-1" : "/hop-2" }); response.end();
    }, { onBudgetExhausted: report => reports.push(report) });
    const ctx = { ...contextFixture(), publisherPhase: "identity" as const };
    await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    Object.assign(ctx, { publisherPhase: "licensed_file" });
    await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    await expect(client.safeFetch("http://publisher.org/hop-0", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(client.safeFetch("http://publisher.org/never-dispatched?secret=private", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      requestId: ctx.requestId, exhausted: "licensed_file_attempts", limit: 10,
      dispatched: { html: 10, image: 0, robots: 1 },
      blocked: { kind: "html", phase: "licensed_file", hop: 1, origin: 1, target: 3 },
      attempts: [
        { ordinal: 1, kind: "robots", phase: "identity", hop: 0, origin: 1, target: 1, status: 404 },
        { ordinal: 2, kind: "html", phase: "identity", hop: 0, origin: 1, target: 2, status: 302 },
        { ordinal: 3, kind: "html", phase: "identity", hop: 1, origin: 1, target: 3, status: 302 },
        { ordinal: 4, kind: "html", phase: "identity", hop: 2, origin: 1, target: 4, status: 200 },
        { ordinal: 5, kind: "html", phase: "licensed_file", hop: 0, target: 2, status: 302 },
        { ordinal: 6, kind: "html", phase: "licensed_file", hop: 1, target: 3, status: 302 },
        { ordinal: 7, kind: "html", phase: "licensed_file", hop: 2, target: 4, status: 200 },
        { ordinal: 8, kind: "html", phase: "licensed_file", hop: 0, target: 2, status: 302 },
        { ordinal: 9, kind: "html", phase: "licensed_file", hop: 1, target: 3, status: 302 },
        { ordinal: 10, kind: "html", phase: "licensed_file", hop: 2, target: 4, status: 200 },
        { ordinal: 11, kind: "html", phase: "licensed_file", hop: 0, target: 2, status: 302 },
      ],
    });
    expect(JSON.stringify(reports)).not.toMatch(/publisher\.org|hop-|secret|private|https?:|bytes|excerpt/);
    expect(client.requests.filter(request => request.path.startsWith("/hop-"))).toHaveLength(10);
    // A new request has a fresh budget and never inherits this request's trace.
    await expect(client.safeFetch("http://publisher.org/hop-2", "html", contextFixture())).resolves.toMatchObject({ status: 200 });
    expect(reports).toHaveLength(1);
  });
  it("distinguishes origin exhaustion during robots redirects from the HTML cap", async () => {
    const reports: unknown[] = [];
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt" && request.headers.host!.startsWith("source-")) {
        response.writeHead(302, { location: `http://${request.headers.host!.replace("source-", "destination-")}/robots.txt` }); response.end();
      } else ordinary(request, response);
    }, { onBudgetExhausted: report => reports.push(report) });
    const ctx = contextFixture();
    for (let index = 0; index < 4; index++) await client.safeFetch(`http://source-${index}.org/page`, "html", ctx).catch(() => {});
    await expect(client.safeFetch("http://ninth.org/page", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ exhausted: "policy_origins", limit: 8, dispatched: { html: 4, image: 0, robots: 8 }, blocked: { kind: "html", hop: 0 } });
  });
  it("keeps a failing diagnostics sink from changing budget enforcement", async () => {
    const client = await setup(ordinary, { onBudgetExhausted: () => { throw new Error("diagnostics unavailable"); } });
    const ctx = contextFixture();
    for (let index = 0; index < 12; index++) await client.safeFetch(`http://publisher.org/${index}`, "html", ctx);
    await expect(client.safeFetch("http://publisher.org/thirteenth", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.filter(request => request.path !== "/robots.txt")).toHaveLength(12);
  });
  it("uses the same HTTP target ID when a repeated fragment URL is rejected before dispatch", async () => {
    const reports: unknown[] = [];
    const client = await setup(ordinary, { onBudgetExhausted: report => reports.push(report) });
    const ctx = contextFixture();
    for (let index = 0; index < 12; index++) await client.safeFetch("http://publisher.org/page#section", "html", ctx);
    await expect(client.safeFetch("http://publisher.org/page#section", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ blocked: { target: 2 }, attempts: [
      { target: 1 }, ...Array.from({ length: 12 }, () => ({ target: 2 })),
    ] });
  });
  it("allows twelve HTML dispatches and rejects attempt thirteen", async () => {
    const client = await setup(ordinary);
    const ctx = contextFixture();
    for (let index = 1; index <= 12; index++) {
      await expect(client.safeFetch(`http://publisher.org/page-${index}`, "html", ctx)).resolves.toMatchObject({ status: 200 });
    }
    await expect(client.safeFetch("http://publisher.org/page-13", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.filter(request => request.path !== "/robots.txt").map(request => request.path))
      .toEqual(Array.from({ length: 12 }, (_, index) => `/page-${index + 1}`));
  });
  it("reserves the final two HTML attempts from licensed files for official corroboration", async () => {
    const reports: unknown[] = [];
    const client = await setup(ordinary, { onBudgetExhausted: report => reports.push(report) });
    const ctx = { ...contextFixture(), publisherPhase: "identity" as const };
    await client.safeFetch("http://publisher.org/identity-1", "html", ctx);
    await client.safeFetch("http://publisher.org/identity-2", "html", ctx);
    Object.assign(ctx, { publisherPhase: "licensed_category" });
    await client.safeFetch("http://publisher.org/category", "html", ctx);
    Object.assign(ctx, { publisherPhase: "licensed_file" });
    for (let index = 1; index <= 7; index++) await client.safeFetch(`http://publisher.org/file-${index}`, "html", ctx);
    await expect(client.safeFetch("http://publisher.org/file-8", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    Object.assign(ctx, { publisherPhase: "official_corroboration" });
    await expect(client.safeFetch("http://publisher.org/corroboration", "html", ctx)).resolves.toMatchObject({ status: 200 });
    await expect(client.safeFetch("http://publisher.org/corroboration-final", "html", ctx)).resolves.toMatchObject({ status: 200 });
    await expect(client.safeFetch("http://publisher.org/page-13", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.filter(request => request.path !== "/robots.txt").map(request => request.path)).toEqual([
      "/identity-1", "/identity-2", "/category", "/file-1", "/file-2", "/file-3", "/file-4", "/file-5", "/file-6", "/file-7",
      "/corroboration", "/corroboration-final",
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ exhausted: "licensed_file_attempts", limit: 10,
      dispatched: { html: 10, image: 0 }, blocked: { phase: "licensed_file" } });
  });
});

describe("pinned public-address transport", () => {
  it.each([
    ["loopback", "http://127.0.0.1/a", "127.0.0.1"],
    ["RFC1918 10/8", "http://10.0.0.1/a", "10.0.0.1"],
    ["RFC1918 172/12", "http://172.16.0.1/a", "172.16.0.1"],
    ["RFC1918 192/16", "http://192.168.1.1/a", "192.168.1.1"],
    ["metadata", "http://169.254.169.254/a", "169.254.169.254"],
    ["IPv6 loopback", "http://[::1]/a", "::1"],
    ["IPv6 ULA", "http://[fd00::1]/a", "fd00::1"],
    ["IPv6 link local", "http://[fe80::1]/a", "fe80::1"],
    ["mapped private", "http://[::ffff:10.0.0.1]/a", "::ffff:10.0.0.1"],
    ["CGNAT", "http://100.64.0.1/a", "100.64.0.1"],
    ["unspecified", "http://0.0.0.0/a", "0.0.0.0"],
    ["multicast", "http://224.0.0.1/a", "224.0.0.1"],
    ["documentation", "http://192.0.2.1/a", "192.0.2.1"],
  ])("rejects %s without opening a socket", async (_, url, address) => {
    const client = await setup(ordinary, { resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
    await expect(client.safeFetch(url, "html", contextFixture())).rejects.toMatchObject({ code: "unsafe_target" });
    expect(client.connections).toHaveLength(0);
  });
  it.each(["ftp://publisher.org/a", "http://name:secret@publisher.org/a", "http://publisher.org:3000/a", "file:///etc/passwd"])("rejects URL shape %s before connecting", async (url) => {
    const client = await setup(ordinary);
    await expect(client.safeFetch(url, "html", contextFixture())).rejects.toMatchObject({ code: "unsafe_target" });
    expect(client.connections).toHaveLength(0);
  });
  it("rejects mixed public/private DNS answers", async () => {
    const client = await setup(ordinary, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 }] });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "unsafe_target" });
    expect(client.connections).toHaveLength(0);
  });
  it("pins the public IP and preserves Host and TLS server name", async () => {
    const client = await setup(ordinary);
    const result = await client.safeFetch("https://publisher.org/a", "html", contextFixture());
    expect(new TextDecoder().decode(result.bytes)).toBe("<h1>Publisher</h1>");
    expect(result).toMatchObject({ finalUrl: "https://publisher.org/a", contentType: "text/html", status: 200 });
    expect(client.connections.every((connection) => connection.address === "93.184.216.34" && connection.servername === "publisher.org")).toBe(true);
    expect(client.requests.every((request) => request.host === "publisher.org" && request.userAgent === "VisualUniversityProfile/0.1 (+https://visual-profile-project.org/contact)")).toBe(true);
  });
  it.each(["identity", "official_corroboration", "licensed_file"] as const)("allows a bounded %s fetch to complete robots and HTML steps that jointly exceed three seconds", async publisherPhase => {
    const reports: unknown[] = [];
    const client = await setup((request, response) => {
      setTimeout(() => ordinary(request, response), 1_550);
    }, { onLocalTimeout: report => { reports.push(report); } });
    const ctx = { ...contextFixture(), publisherPhase };
    const startedAt = Date.now();

    await expect(client.safeFetch("https://publisher.org/a", "html", ctx)).resolves.toMatchObject({ status: 200 });

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(reports).toEqual([]);
    expect(client.requests.map(request => request.path)).toEqual(["/robots.txt", "/a"]);
  });
  it("rechecks redirects and never connects to a private destination", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(302, { location: "http://169.254.169.254/latest" }); response.end();
    });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "unsafe_target" });
    expect(client.connections.every((connection) => connection.address === "93.184.216.34")).toBe(true);
  });
  it("rejects DNS rebinding on the next request instead of falling back to DNS at connect", async () => {
    let lookups = 0;
    const client = await setup(ordinary, { resolve: async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "10.0.0.1", family: 4 }] });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "unsafe_target" });
    expect(client.connections.every((connection) => connection.address === "93.184.216.34")).toBe(true);
  });
  it("stops before following the fourth redirect", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(302, { location: `/hop-${Number(request.url!.split("-")[1]) + 1}` }); response.end();
    });
    await expect(client.safeFetch("http://publisher.org/hop-0", "html", contextFixture())).rejects.toMatchObject({ code: "protocol_error" });
    expect(client.requests.filter((request) => request.path.startsWith("/hop-")).map((request) => request.path)).toEqual(["/hop-0", "/hop-1", "/hop-2", "/hop-3"]);
  });
  it("limits decompressed HTML bytes even when compressed Content-Length is small", async () => {
    const compressed = gzipSync(Buffer.alloc(2_000_001, "a"));
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": compressed.length }); response.end(compressed);
    });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "invalid_media" });
  });
  it("ends an endless body at the remaining deadline", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(200, { "content-type": "text/html" }); response.write("start");
    });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture(100))).rejects.toMatchObject({ code: "deadline" });
  });
  it("aborts active work and can fetch again after releasing its slots", async () => {
    const controller = new AbortController();
    const client = await setup((request, response) => {
      if (request.url !== "/hang") return ordinary(request, response);
      response.writeHead(200, { "content-type": "text/html" }); response.write("start"); controller.abort();
    });
    await expect(client.safeFetch("http://publisher.org/hang", "html", contextFixture(1_000, controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture())).resolves.toMatchObject({ status: 200 });
  });
  it("bounds a DNS lookup that never settles", async () => {
    const client = await setup(ordinary, { resolve: () => new Promise(() => {}) });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture(60))).rejects.toMatchObject({ code: "deadline" });
    expect(client.connections).toHaveLength(0);
  });
  it("aborts a pre-cancelled request before DNS or socket work", async () => {
    const controller = new AbortController(); controller.abort();
    const client = await setup(ordinary);
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture(1_000, controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    expect(client.connections).toHaveLength(0);
  });
  it("never opens a socket after a DNS lookup resolves past cancellation", async () => {
    let finish!: (value: Array<{ address: string; family: number }>) => void;
    const client = await setup(ordinary, { resolve: () => new Promise((resolve) => { finish = resolve; }) });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture(60))).rejects.toMatchObject({ code: "deadline" });
    finish([{ address: "10.0.0.1", family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.connections).toHaveLength(0);
  });
});

describe("publisher access", () => {
  it("retains pacing for authorized callers and atomically reserves same-timestamp starts", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const policy = createAccessPolicy({ contactUrl: configured.contactUrl, fetchRobots: async (url) => ({
        finalUrl: url, status: 200, contentType: "text/plain", retrievedAt: "2026-09-16T00:00:00Z",
        bytes: new TextEncoder().encode("User-agent: *\nCrawl-delay: 0.1\n"),
      }) });
      const ctx = contextFixture(5_000);
      expect(await policy.checkAccess("http://paced.org/a", ctx)).toEqual({ allowed: true });
      // DNS/socket queuing delays these already-authorized callers beyond the
      // first eligible start. An unrelated origin must not erase their pacing.
      clock.mockReturnValue(1_200);
      expect(await policy.waitForStart("http://unrelated.org/a", ctx)).toEqual({ allowed: true });
      const burstContext = { ...ctx, deadlineAt: 1_250 };
      expect(await Promise.all([
        policy.waitForStart("http://paced.org/a", burstContext),
        policy.waitForStart("http://paced.org/b", burstContext),
      ])).toEqual([{ allowed: true }, { allowed: false, reason: "deadline", retryAt: 1_300 }]);
    } finally { clock.mockRestore(); }
  });
  it.each(["sequential", "concurrent"])("charges robots redirect origins to the original eight-origin allowance (%s)", async (mode) => {
    const client = await setup((request, response) => {
      const host = request.headers.host!;
      if (host.startsWith("source-")) {
        response.writeHead(302, { location: `http://${host.replace("source-", "destination-")}/robots.txt` }); response.end();
      } else ordinary(request, response);
    });
    const ctx = contextFixture();
    const urls = Array.from({ length: 8 }, (_, index) => `http://source-${index}.org/a`);
    const results = [];
    if (mode === "concurrent") results.push(...await Promise.all(urls.map((url) => client.checkAccess(url, ctx))));
    else for (const url of urls) results.push(await client.checkAccess(url, ctx));
    const contactedOrigins = new Set(client.requests.map((request) => request.host));
    expect(contactedOrigins.size).toBeLessThanOrEqual(8);
    expect(results.some((result) => result.reason === "budget_exhausted")).toBe(true);
    expect(client.requests.every((request) => request.path === "/robots.txt")).toBe(true);
  });
  it.each([undefined, "", "https://example.com/contact", "http://localhost/contact"])("disables crawling without a real configured contact URL (%s)", async (contactUrl) => {
    const client = await setup(ordinary, { contactUrl });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(client.connections).toHaveLength(0);
  });
  it.each([401, 403, 429, 500])("skips content when robots returns %s", async (status) => {
    const client = await setup((_, response) => { response.writeHead(status); response.end(); });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
    expect(client.requests.map((request) => request.path)).toEqual(["/robots.txt"]);
  });
  it("honors robots disallow for an image origin", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") { response.writeHead(200, { "content-type": "text/plain" }); response.end(restrictiveRobots); }
      else ordinary(request, response);
    });
    await expect(client.safeFetch("http://images.org/private/photo.jpg", "image", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(client.requests.map((request) => request.path)).toEqual(["/robots.txt"]);
  });
  it("skips crawl delays that cannot fit the deadline", async () => {
    const client = await setup((_, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(restrictiveRobots); });
    const ctx = contextFixture(1_000);
    expect(await client.checkAccess("http://publisher.org/a", ctx)).toMatchObject({ allowed: false, reason: "deadline" });
  });
  it("retains Retry-After and refuses further work in the blocked interval", async () => {
    const client = await setup((_, response) => { response.writeHead(429, { "retry-after": "120" }); response.end(); });
    const before = Date.now();
    const result = await client.checkAccess("http://publisher.org/a", contextFixture());
    expect(result).toMatchObject({ allowed: false, reason: "access_denied" });
    expect(result.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    await client.checkAccess("http://publisher.org/b", contextFixture());
    expect(client.requests).toHaveLength(1);
  });
  it("honors configured publisher prohibition before connecting", async () => {
    const client = await setup(ordinary, { publisherRules: new Map([["https://publisher.org", { crawl: "deny" }]]) });
    await expect(client.safeFetch("https://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(client.connections).toHaveLength(0);
  });
  it("keeps the eight-origin policy budget across calls sharing the run context", async () => {
    const client = await setup(ordinary);
    const ctx = contextFixture();
    for (let index = 0; index < 8; index++) expect(await client.checkAccess(`http://publisher-${index}.org/a`, ctx)).toMatchObject({ allowed: true });
    expect(await client.checkAccess("http://publisher-ninth.org/a", ctx)).toMatchObject({ allowed: false, reason: "budget_exhausted" });
    expect(client.requests).toHaveLength(8);
  });
  it("reuses transient robots evidence within one run", async () => {
    const client = await setup(ordinary);
    const ctx = contextFixture();
    await client.safeFetch("http://publisher.org/a", "html", ctx);
    await client.safeFetch("http://publisher.org/b", "html", ctx);
    expect(client.requests.filter((request) => request.path === "/robots.txt")).toHaveLength(1);
  });
  it("caps publisher pages at twelve per run", async () => {
    const client = await setup(ordinary);
    const ctx = contextFixture();
    for (let index = 0; index < 12; index++) await client.safeFetch(`http://publisher.org/${index}`, "html", ctx);
    await expect(client.safeFetch("http://publisher.org/thirteenth", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.some((request) => request.path === "/thirteenth")).toBe(false);
  });
  it("does not follow a robots redirect into a publisher with an explicit prohibition", async () => {
    const client = await setup((_, response) => { response.writeHead(302, { location: "http://denied.org/robots.txt" }); response.end(); },
      { publisherRules: new Map([["http://denied.org", { crawl: "deny" }]]) });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
    expect(client.requests.map((request) => request.host)).toEqual(["publisher.org"]);
  });
  it("checks the destination image origin after a redirect", async () => {
    const client = await setup((request, response) => {
      if (request.headers.host === "images.org") { response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nDisallow: /\n"); }
      else if (request.url === "/robots.txt") ordinary(request, response);
      else { response.writeHead(302, { location: "http://images.org/photo.jpg" }); response.end(); }
    });
    await expect(client.safeFetch("http://publisher.org/photo.jpg", "image", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(client.requests.filter((request) => request.host === "images.org").map((request) => request.path)).toEqual(["/robots.txt"]);
  });
  it.each(["<html>challenge</html>", "not a robots file"]) ("fails closed on ambiguous robots content: %s", async (text) => {
    const client = await setup((_, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(text); });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
    expect(client.requests).toHaveLength(1);
  });
  it.each(["header", "metadata"])("honors explicit publisher use prohibition in %s", async (where) => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(200, { "content-type": "text/html", ...(where === "header" ? { "x-robots-tag": "noimageai" } : {}) });
      response.end(where === "metadata" ? '<meta name="robots" content="noai">' : "Publisher");
    });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
  });
  it("paces every later request including robots in another run", async () => {
    const starts: number[] = [];
    const client = await setup((request, response) => {
      starts.push(Date.now());
      if (request.url === "/robots.txt") { response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nCrawl-delay: 0.08\n"); }
      else ordinary(request, response);
    });
    await client.safeFetch("http://publisher.org/a", "html", contextFixture());
    await client.safeFetch("http://publisher.org/b", "html", contextFixture());
    expect(starts).toHaveLength(4);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(70);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(70);
    expect(starts[3] - starts[2]).toBeGreaterThanOrEqual(70);
  });
  it("reports publisher Retry-After on the failed fetch", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(429, { "retry-after": "120" }); response.end();
    });
    const result = await client.safeFetch("http://publisher.org/a", "html", contextFixture()).catch((error) => error);
    expect(result.code).toBe("access_denied");
    expect(result.retryAt).toBeGreaterThan(Date.now());
  });
  it("retains crawl pacing even when the first content fetch cannot fit it", async () => {
    const client = await setup((_, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(restrictiveRobots); });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture(100))).toMatchObject({ allowed: false, reason: "deadline" });
    expect(await client.checkAccess("http://publisher.org/b", contextFixture(100))).toMatchObject({ allowed: false, reason: "deadline" });
    expect(client.requests).toHaveLength(1);
  });
  it("fails closed on an invalid crawl delay", async () => {
    const client = await setup((_, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nCrawl-delay: invalid\n"); });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
  });
  it("honors Retry-After even on a robots 404 response", async () => {
    const client = await setup((_, response) => { response.writeHead(404, { "retry-after": "60" }); response.end(); });
    expect(await client.checkAccess("http://publisher.org/a", contextFixture())).toMatchObject({ allowed: false, reason: "access_denied" });
  });
  it("recognizes robot metadata regardless of attribute casing", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt") return ordinary(request, response);
      response.writeHead(200, { "content-type": "text/html" }); response.end('<meta name="RoBoTs" content="NOAI">');
    });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
  });
  it("counts redirected publisher page attempts in the twelve-page ceiling", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt" || request.url === "/hop-2") return ordinary(request, response);
      response.writeHead(302, { location: request.url === "/hop-0" ? "/hop-1" : "/hop-2" }); response.end();
    });
    const ctx = contextFixture();
    for (let index = 0; index < 4; index++) await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    await expect(client.safeFetch("http://publisher.org/hop-0", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.filter((request) => request.path.startsWith("/hop-"))).toHaveLength(12);
  });
  it("honors Retry-After before a cross-origin redirect", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt" || request.headers.host === "destination.org") return ordinary(request, response);
      response.writeHead(302, { location: "http://destination.org/a", "retry-after": "60" }); response.end();
    });
    await expect(client.safeFetch("http://publisher.org/a", "html", contextFixture())).rejects.toMatchObject({ code: "access_denied" });
    expect(client.requests.some((request) => request.host === "destination.org")).toBe(false);
  });
  it("enforces global six and per-host two concurrent requests", async () => {
    let active = 0, peak = 0, hostPeak = 0;
    const byHost = new Map<string, number>();
    const client = await setup((request, response) => {
      const host = request.headers.host!;
      active++; peak = Math.max(peak, active);
      byHost.set(host, (byHost.get(host) ?? 0) + 1); hostPeak = Math.max(hostPeak, byHost.get(host)!);
      setTimeout(() => { active--; byHost.set(host, byHost.get(host)! - 1); ordinary(request, response); }, 20);
    });
    const results = await Promise.all(Array.from({ length: 18 }, (_, index) => client.safeFetch(`http://publisher-${index % 3}.org/a`, "html", contextFixture())));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(6);
    expect(hostPeak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});
