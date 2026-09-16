// Test-only runtime. No production module imports this file or enables these transports.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import next from "next";
import { profileFixture, fixtureSecret } from "./profile-fixture";
import { createProfileHandler } from "../../src/server/profile/route-handler";
import { createSessionHandler } from "../../src/server/profile/session";
const port = 3100, origin = `http://localhost:${port}`;
const app = next({ dev: true, hostname: "localhost", port }); await app.prepare();
const nextHandler = app.getRequestHandler();
const fixture = await profileFixture(); const hanging = await profileFixture({ hangAi: true }); let activeFixture = fixture;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const address = String(url);
  return /api\.openai\.com|wikidata\.org/.test(address) ? activeFixture.providerFetch(url, init) : realFetch(url, init);
}) as typeof fetch;
const requestWork = new Set<Promise<void>>();
const config = { origin, secret: fixtureSecret, clientIp: () => "198.51.100.4", waitUntil(work: Promise<void>) {
  requestWork.add(work);
  void work.then(() => requestWork.delete(work), error => { requestWork.delete(work); console.error("Fixture request cleanup failed", error); });
} };
const profile = createProfileHandler({ ...config, services: async () => activeFixture.services });
const session = createSessionHandler(config);
const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/fixture-mode" && incoming.method === "POST") { const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); activeFixture = Buffer.concat(chunks).toString().includes("hang") ? hanging : fixture; outgoing.writeHead(204); outgoing.end(); return; }
  if (incoming.url === "/fixture-raster") { outgoing.writeHead(200, { "content-type": "image/png" }); outgoing.end(fixture.raster); return; }
  if (!["/api/profile", "/api/session"].includes(incoming.url ?? "")) { await nextHandler(incoming, outgoing); return; }
  const abort = new AbortController(); outgoing.once("close", () => abort.abort());
  const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers,
    body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, signal: abort.signal, duplex: "half" } as RequestInit);
  const response = await (incoming.url === "/api/profile" ? profile : session)(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) { const reader = response.body.getReader(); try { while (true) { const { done, value } = await reader.read(); if (done || outgoing.destroyed) break; outgoing.write(value); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
  outgoing.end();
});
server.listen(port, "localhost");
process.once("SIGTERM", () => { server.close(); void Promise.allSettled([...requestWork]).then(() => Promise.all([fixture.close(), hanging.close()])); });
