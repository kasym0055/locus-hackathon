import type { FetchResult, RunContext, University, UsagePolicy } from "@/server/contracts";
import { createServer, type RequestListener } from "node:http";
import { connect, type Socket } from "node:net";
import type { buildConnector } from "undici";
import type { Evidence } from "@/server/contracts";
import type { decide } from "@/server/policy/decide";

export function decisionFixture(patch: { authority: Evidence["authority"]; association: Evidence["association"]; corroboration: 20 | 10 | 0; visual: 10 | 5 | 0 }): Parameters<typeof decide>[0] {
  const policy: UsagePolicy = { ...transientPolicy, display: "direct_permitted" };
  const source = { id: "attribution-source", url: "https://example.edu/library", retrievedAt: "2026-09-16T00:00:00Z", policy };
  return { resolved: true, usable: true, evidence: { source, imageId: "image-one", imageUrl: "https://example.edu/photo.jpg",
    excerpt: "The selected campus library reading room.", association: patch.association, authority: patch.authority,
    locationSupported: true, locationScope: "campus", categorySupported: true,
    officialDirect: patch.authority === "official" && patch.association === "explicit",
    independentEquivalent: patch.association === "explicit" && patch.corroboration === 20,
    corroboration: patch.corroboration, corroborationEvidenceIds: patch.corroboration ? ["independent-source"] : [],
    corroborationSources: patch.corroboration ? [{ source: { ...source, id: "independent-source", url: "https://independent.example/library" },
      imageId: "image-one", excerpt: "Independent reporting identifies this reading room at the selected campus.",
      independent: true, locationSupported: true }] : [], conflict: false, forbidden: false },
    assessment: { imageId: "image-one", assessed: true, category: "library", visual: patch.visual,
      safety: "clear", relevance: "relevant", authenticity: "photo", location: "supported",
      evidenceIds: ["attribution-source"], observations: ["Visible shelves and reading desks."], uncertainties: [] } };
}

// Self-authored synthetic test material. Never a live demo or a factual campus source.
export const syntheticHtml = `<!doctype html><html><head><title>Example University visit</title></head>
<body><article><h1>Example University visits Partner University</h1>
<p>The photographs below show the Partner University campus, not Example University.</p>
<figure><img src="../photos/visit.jpg" srcset="../photos/visit.jpg 1x, ../photos/visit-large.jpg 2x">
<figcaption>Partner University library during the delegation visit. Photo: Synthetic Author.</figcaption></figure>
<div class="gallery-item"><img data-src="/photos/court.jpg"><p class="caption">Partner University court</p></div>
<img src="/logo.svg"></article><footer>Example University</footer></body></html>`;
export const restrictiveRobots = "User-agent: *\nDisallow: /private\nCrawl-delay: 10\n";
export const transientPolicy: UsagePolicy = {
  origin: "synthetic-discovery", policyVersion: "v1", basis: ["synthetic fixture restriction"],
  display: "link_only", retention: "transient_only",
};
export function universityFixture(): University {
  return { id: "synthetic-example", name: "Example University", aliases: [], campus: "Main",
    city: "Example City", country: "KZ", officialDomains: ["example.edu"], sources: [] };
}
export function publisherFixture(html = syntheticHtml): FetchResult {
  return { finalUrl: "https://example.edu/news/visit", contentType: "text/html",
    bytes: new TextEncoder().encode(html), retrievedAt: "2026-09-16T00:00:00.000Z", status: 200 };
}
export function contextFixture(milliseconds = 27_000, signal = new AbortController().signal): RunContext {
  const now = Date.now();
  return { requestId: "synthetic-request", sessionId: "synthetic-session", ipHash: "synthetic-ip",
    startedAt: now, deadlineAt: now + milliseconds, signal };
}

// Only this test utility maps an already-validated public destination onto a local socket.
export async function transportFixture(handler: RequestListener) {
  const connections: Array<{ address: string; servername?: string; protocol: string }> = [];
  const requests: Array<{ path: string; host?: string; userAgent?: string }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", host: request.headers.host, userAgent: request.headers["user-agent"] });
    handler(request, response);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test socket unavailable");
  const connector: buildConnector.connector = (options, callback) => {
    connections.push({ address: options.hostname, servername: options.servername, protocol: options.protocol });
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => callback(null, socket));
    socket.once("error", (error) => callback(error, null));
  };
  return { connector, connections, requests, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
