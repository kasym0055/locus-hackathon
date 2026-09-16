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
  it("caps publisher pages at eight per run", async () => {
    const client = await setup(ordinary);
    const ctx = contextFixture();
    for (let index = 0; index < 8; index++) await client.safeFetch(`http://publisher.org/${index}`, "html", ctx);
    await expect(client.safeFetch("http://publisher.org/ninth", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.some((request) => request.path === "/ninth")).toBe(false);
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
  it("counts redirected publisher page attempts in the eight-page ceiling", async () => {
    const client = await setup((request, response) => {
      if (request.url === "/robots.txt" || request.url === "/hop-2") return ordinary(request, response);
      response.writeHead(302, { location: request.url === "/hop-0" ? "/hop-1" : "/hop-2" }); response.end();
    });
    const ctx = contextFixture();
    await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    await client.safeFetch("http://publisher.org/hop-0", "html", ctx);
    await expect(client.safeFetch("http://publisher.org/hop-0", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(client.requests.filter((request) => request.path.startsWith("/hop-"))).toHaveLength(8);
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
