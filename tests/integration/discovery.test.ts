import { describe, expect, it } from "vitest";
import { createBraveSearch } from "@/server/discovery/brave";
import { createWikidataLookup } from "@/server/discovery/wikidata";
import { createDiscoveryPlanner } from "@/server/discovery/planner";
import { createLedger } from "@/server/usage/ledger";
import { createResolver } from "@/server/discovery/resolver";
import { contextFixture, publisherFixture, universityFixture } from "../support/fixtures";

describe("real adapter HTTP boundaries", () => {
  it.each(["web", "images"] as const)("serializes strict SafeSearch and header auth for %s and reserves before dispatch", async (kind) => {
    const events: string[] = [];
    const requests: Request[] = [];
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => { events.push("reserve"); return "reservation"; },
      settle: async () => { events.push("settle"); },
      check: async () => { events.push("check"); },
    }, fetch: async (url, init) => {
      events.push("dispatch"); requests.push(new Request(url, init));
      return Response.json(kind === "web" ? { type: "search", web: { type: "search", results: [{ type: "search_result", title: "Synthetic", url: "https://example.edu/", description: "Never evidence" }] } }
        : { type: "images", results: [{ type: "image_result", title: "Synthetic", url: "https://example.edu/", source: "example.edu", thumbnail: { src: "https://proxy.example/thumbnail" }, properties: { url: "https://example.edu/photo.jpg" } }] });
    } });
    const results = await search({ query: "Example университет", kind }, contextFixture());
    const request = requests[0];
    expect(new URL(request.url).pathname).toBe(`/res/v1/${kind}/search`);
    expect(new URL(request.url).searchParams.get("safesearch")).toBe("strict");
    expect(new URL(request.url).searchParams.get("q")).toBe("Example университет");
    expect(request.headers.get("x-subscription-token")).toBe("synthetic-key");
    expect(request.url).not.toContain("synthetic-key");
    expect(events.indexOf("reserve")).toBeLessThan(events.indexOf("dispatch"));
    expect(results).toEqual([{ pageUrl: "https://example.edu/", ...(kind === "images" ? { imageUrl: "https://example.edu/photo.jpg" } : {}), policy: expect.objectContaining({ retention: "transient_only" }) }]);
  });
  it("does not dispatch paid HTTP when the ledger is down", async () => {
    let dispatches = 0;
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: createLedger(async () => { throw new Error("store down"); }),
      fetch: async () => { dispatches++; return Response.json({}); } });
    await expect(search({ query: "test", kind: "web" }, contextFixture())).rejects.toThrow();
    expect(dispatches).toBe(0);
  });
  it("retains unknown billing and performs no automatic retry", async () => {
    let attempts = 0;
    const settled: Array<number | null> = [];
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => "id", settle: async (_id, actual) => { settled.push(actual); }, check: async () => {},
    }, fetch: async () => { attempts++; throw new Error("connection lost"); } });
    await expect(search({ query: "test", kind: "web" }, contextFixture())).rejects.toThrow();
    expect(attempts).toBe(1); expect(settled).toEqual([null]);
  });
  it("rejects malformed provider payloads rather than admitting raw records", async () => {
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => "id", settle: async () => {}, check: async () => {},
    }, fetch: async () => Response.json({ web: { results: [{ url: 42 }] } }) });
    await expect(search({ query: "test", kind: "web" }, contextFixture())).rejects.toMatchObject({ code: "invalid_provider_output" });
  });
  it("rejects an unrelated JSON object instead of reporting an empty search", async () => {
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => "id", settle: async () => {}, check: async () => {},
    }, fetch: async () => Response.json({ unrelated: true }) });
    await expect(search({ query: "test", kind: "web" }, contextFixture())).rejects.toMatchObject({ code: "invalid_provider_output" });
  });
  it("withholds offensive image results and never substitutes the provider thumbnail", async () => {
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => "id", settle: async () => {}, check: async () => {},
    }, fetch: async () => Response.json({ type: "images", results: [{ url: "https://example.edu/", properties: { url: "https://example.edu/photo.jpg" }, is_offensive: true },
      { url: "https://example.edu/", thumbnail: { src: "https://proxy.example/photo.jpg" }, properties: null }] }) });
    expect(await search({ query: "test", kind: "images" }, contextFixture())).toEqual([]);
  });
  it("does not dispatch after cancellation or a lost admission lease", async () => {
    let dispatches = 0; const settled: Array<number | null> = [];
    const search = createBraveSearch({ apiKey: "synthetic-key", ledger: {
      reserve: async () => "id", settle: async (_id, actual) => { settled.push(actual); }, check: async () => { throw new Error("lease expired"); },
    }, fetch: async () => { dispatches++; return Response.json({}); } });
    await expect(search({ query: "test", kind: "web" }, contextFixture())).rejects.toThrow();
    expect(dispatches).toBe(0); expect(settled).toEqual([0]);
    const controller = new AbortController(); controller.abort();
    await expect(search({ query: "test", kind: "web" }, contextFixture(27_000, controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    expect(dispatches).toBe(0);
  });
  it("bounds Wikidata to search plus one entity batch and projects actual claims", async () => {
    const requests: URL[] = [];
    const lookup = createWikidataLookup({ fetch: async (url) => {
      const request = new URL(String(url)); requests.push(request);
      return Response.json(request.searchParams.get("action") === "wbsearchentities"
        ? { success: 1, search: [{ id: "Q123", label: "Example University", description: "university in Example City, Example Country" }] }
        : { success: 1, entities: { Q123: { id: "Q123", type: "item", labels: { en: { language: "en", value: "Example University" } }, aliases: { en: [{ language: "en", value: "Example Institute" }] }, descriptions: { en: { language: "en", value: "university in Example City, Example Country" } }, claims: { P856: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { type: "string", value: "https://example.edu/" } } }] } } } });
    } });
    expect(await lookup("Example University", contextFixture())).toEqual([{ entityId: "Q123", name: "Example University", aliases: ["Example Institute"], website: "https://example.edu/", city: "Example City", country: "Example Country" }]);
    expect(requests.map((url) => url.searchParams.get("action"))).toEqual(["wbsearchentities", "wbgetentities"]);
    expect(requests[0].searchParams.get("limit")).toBe("5");
  });
  it.each([
    "international research university based in Astana, Kazakhstan",
    "education organization in Astana, Kazakhstan",
  ])("projects the location from the observed Wikidata description: %s", async (description) => {
    const lookup = createWikidataLookup({ fetch: async (url) => Response.json(new URL(String(url)).searchParams.get("action") === "wbsearchentities"
      ? { success: 1, search: [{ id: "Q123", label: "Example University", description }] }
      : { success: 1, entities: { Q123: { id: "Q123", labels: { en: { value: "Example University" } }, aliases: {}, descriptions: { en: { value: description } }, claims: {
        P856: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: "https://example.edu/" } } }],
      } } } }) });
    expect(await lookup("Example University", contextFixture())).toEqual([expect.objectContaining({ city: "Astana", country: "Kazakhstan" })]);
  });
  it.each(["Примерный университет", "Үлгі университеті"])("keeps the Wikidata full label %s through publisher verification", async (localizedName) => {
    let requests = 0; const inspected: string[] = [];
    const lookup = createWikidataLookup({ fetch: async (url) => {
      requests++;
      return Response.json(new URL(String(url)).searchParams.get("action") === "wbsearchentities"
        ? { success: 1, search: [{ id: "Q123", label: localizedName }] }
        : { success: 1, entities: { Q123: { id: "Q123", labels: {
          en: { value: "Example University" }, ru: { value: "Примерный университет" }, kk: { value: "Үлгі университеті" },
        }, aliases: {}, descriptions: { en: { value: "university in Example City, Example Country" } }, claims: {
          P856: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: "https://example.edu/" } } }],
        } } } });
    } });
    const resolve = createResolver({ lookup, search: async () => [], fetchPage: async (url) => {
      inspected.push(url); return { ...publisherFixture(`<h1>${localizedName}</h1><address>Example City, Example Country <a href="mailto:info@example.edu">Contact</a></address>`), finalUrl: url };
    } });
    const result = await resolve({ query: localizedName, countryHint: "" }, contextFixture());
    expect(inspected).toEqual(["https://example.edu/"]);
    expect(result).toMatchObject({ kind: "resolved", university: { name: "Example University", aliases: expect.arrayContaining([localizedName]) } });
    expect(requests).toBe(2);
  });
});

describe("publisher-first discovery", () => {
  it("finds a bound homepage image without spending on search", async () => {
    let searches = 0;
    const discover = createDiscoveryPlanner({ fetchPage: async () => publisherFixture('<figure><img src="/campus.jpg"><figcaption>Example University campus</figcaption></figure>'),
      search: async () => { searches++; return []; } });
    const result = await discover(universityFixture(), ["campus"], contextFixture());
    expect(result[0].imageUrl).toBe("https://example.edu/campus.jpg");
    expect(result[0].evidence[0].association).toBe("explicit");
    expect(searches).toBe(0);
  });
  it("uses official site search before broad images and binds only original pages", async () => {
    const events: string[] = [];
    const discover = createDiscoveryPlanner({ fetchPage: async (url) => {
      events.push(`page:${url}`);
      return { ...publisherFixture(url.includes("story") ? '<figure><img src="/photo.jpg"><figcaption>Campus view</figcaption></figure>' : '<h1>University</h1>'), finalUrl: url };
    }, search: async (input) => { events.push(`${input.kind}:${input.query}`); return input.kind === "images" ? [{ pageUrl: "https://publisher.example/story", imageUrl: "https://publisher.example/photo.jpg", policy: { origin: "brave", policyVersion: "v1", retention: "transient_only", display: "link_only", basis: ["Brave"] } }] : []; } });
    const result = await discover(universityFixture(), ["campus"], contextFixture());
    expect(events[0]).toBe("page:https://example.edu/");
    expect(events[1]).toContain("web:site:example.edu");
    expect(events[2]).toContain("images:");
    expect(result[0].evidence[0].source.url).toBe("https://publisher.example/story");
  });
});
