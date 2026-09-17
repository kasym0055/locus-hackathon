import { describe, expect, it } from "vitest";
import { createBraveSearch } from "@/server/discovery/brave";
import { createWikidataLookup } from "@/server/discovery/wikidata";
import { createDiscoveryPlanner } from "@/server/discovery/planner";
import { createLedger } from "@/server/usage/ledger";
import { createResolver } from "@/server/discovery/resolver";
import { createSafeFetcher } from "@/server/fetch/safe-fetch";
import { contextFixture, publisherFixture, transportFixture, universityFixture } from "../support/fixtures";

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
      search: async () => { searches++; return []; }, publisherPolicies: new Map([["https://example.edu", {
        origin: "https://example.edu", policyVersion: "v1", retention: "transient_only", display: "direct_permitted",
        basis: ["Synthetic documented display grant"],
      }]]) });
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
  it("continues past link-only official images and admits a file-licensed publisher result with independent official object evidence", async () => {
    const discoveryPolicy = { origin: "brave", policyVersion: "v1", retention: "transient_only" as const,
      display: "link_only" as const, basis: ["Brave discovery"] };
    const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "cache_permitted" as const,
      display: "direct_permitted" as const, basis: ["Documented Wikimedia reuse and direct-display terms"] });
    const original = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_University_atrium.jpg";
    const pages = new Map([
      ["https://example.edu/", '<figure><img src="/official.jpg"><figcaption>Our beautiful atrium at Example University.</figcaption></figure>'],
      ["https://example.edu/campus", '<figure><img src="/tour.jpg"><figcaption>Visitors can tour our beautiful atrium at Example University.</figcaption></figure>'],
      ["https://example.edu/news", "<main>No relevant image</main>"],
      ["https://example.edu/about", "<main>No relevant image</main>"],
      ["https://independent.example/story", '<figure><img src="/unlicensed.jpg"><figcaption>Example University campus</figcaption></figure>'],
      ["https://commons.wikimedia.org/wiki/File:Example_University_atrium.jpg", `<h1>File:Example University atrium.jpg</h1>
        <div class="fullMedia"><a class="internal" href="${original}">Original file</a></div>
        <table><tr><td id="fileinfotpl_desc">Description</td><td>Example University, main atrium. Example City, KZ</td></tr>
        <tr><td id="fileinfotpl_aut">Author</td><td>Fixture Photographer</td></tr></table>
        <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`],
    ]);
    const searches: string[] = []; let fetches = 0;
    const discover = createDiscoveryPlanner({
      fetchPage: async (url) => { if (++fetches > 5) throw { code: "budget_exhausted" };
        return { ...publisherFixture(pages.get(url) ?? "<main>No images</main>"), finalUrl: url }; },
      search: async (input) => { searches.push(input.kind); return input.kind === "web"
        ? ["campus", "news", "about"].map((page) => ({ pageUrl: `https://example.edu/${page}`, policy: discoveryPolicy }))
        : [{ pageUrl: "https://independent.example/story", imageUrl: "https://independent.example/unlicensed.jpg", policy: discoveryPolicy },
          { pageUrl: "https://commons.wikimedia.org/wiki/File:Example_University_atrium.jpg", imageUrl: original, policy: discoveryPolicy }]; },
      publisherPolicies: new Map([
        ["https://commons.wikimedia.org", grant("https://commons.wikimedia.org")],
        ["https://upload.wikimedia.org", grant("https://upload.wikimedia.org")],
      ]),
    });
    const [candidate] = await discover(universityFixture(), ["campus"], contextFixture());
    expect(searches).toEqual(["images", "web"]);
    expect(fetches).toBe(4);
    expect(candidate).toMatchObject({ imageUrl: original, policy: { display: "direct_permitted", retention: "transient_only",
      attributionText: "Fixture Photographer — CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" } });
    expect(candidate.evidence[0]).toMatchObject({ authority: "attributable", association: "explicit",
      corroboration: 20, independentEquivalent: true, corroborationEvidenceIds: [expect.any(String)] });
    expect(candidate.evidence[0].corroborationSources).toEqual([expect.objectContaining({ independent: true,
      locationSupported: true, excerpt: expect.stringContaining("beautiful atrium") })]);
  });
  it("crawls a configured licensed publisher category and skips files without independent object corroboration", async () => {
    const discoveryPolicy = { origin: "brave", policyVersion: "v1", retention: "transient_only" as const,
      display: "link_only" as const, basis: ["Brave discovery"] };
    const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "cache_permitted" as const,
      display: "direct_permitted" as const, basis: ["Documented Wikimedia reuse and direct-display terms"] });
    const unrelatedOriginal = "https://upload.wikimedia.org/wikipedia/commons/a/aa/Example_University_Astana.jpg";
    const labOriginal = "https://upload.wikimedia.org/wikipedia/commons/a/ac/Example_University_lab.jpg";
    const targetOriginal = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_University_atrium.jpg";
    const filePage = (original: string, description: string, author: string) => `<h1>File page</h1>
      <div class="fullMedia"><a class="internal" href="${original}">Original file</a></div>
      <table><tr><td id="fileinfotpl_desc">Description</td><td>${description}</td></tr>
      <tr><td id="fileinfotpl_aut">Author</td><td>${author}</td></tr></table>
      <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`;
    const category = "https://commons.wikimedia.org/wiki/Category:Example_University";
    const event = "https://commons.wikimedia.org/wiki/File:Example_University_Astana.jpg";
    const lab = "https://commons.wikimedia.org/wiki/File:Example_University.jpg";
    const target = "https://commons.wikimedia.org/wiki/File:Example_University_atrium.jpg";
    const corroboration = "https://example.edu/news/atrium";
    const about = "https://example.edu/about";
    const pages = new Map([
      ["https://example.edu/", '<a href="/campus">Campus tour</a><main>Example University</main>'],
      ["https://example.edu/campus", "<main>Campus visitor information.</main>"],
      [about, "<main>General university information.</main>"],
      [corroboration, '<figure><img src="/news.jpg"><figcaption>Our beautiful main atrium welcomes campus visitors.</figcaption></figure>'],
      [category, `<div class="gallery"><a href="/wiki/File:Example_University_Astana.jpg">University</a>
        <a href="/wiki/File:Example_University.jpg">Laboratory</a>
        <a href="/wiki/File:Example_University_atrium.jpg">Atrium</a></div>`],
      [event, filePage(unrelatedOriginal, "Example University ceremony. Example City, KZ", "Event Photographer")],
      [lab, filePage(labOriginal, "Example University laboratory. Example City, KZ", "Lab Photographer")],
      [target, filePage(targetOriginal, "Example University, main atrium. Example City, KZ", "Campus Photographer")],
    ]);
    const searches: string[] = []; const fetched: string[] = []; let sharedFetches = 3;
    const discover = createDiscoveryPlanner({
      fetchPage: async (url) => { if (++sharedFetches > 8) throw { code: "budget_exhausted" }; fetched.push(url);
        return { ...publisherFixture(pages.get(url) ?? "<main>No images</main>"), finalUrl: url }; },
      search: async (input) => { searches.push(`${input.kind}:${input.query}`); return input.kind !== "web" ? []
        : input.query.includes('"atrium"') ? [{ pageUrl: corroboration, policy: discoveryPolicy }]
        : [{ pageUrl: about, policy: discoveryPolicy }]; },
      publisherPolicies: new Map([
        ["https://commons.wikimedia.org", grant("https://commons.wikimedia.org")],
        ["https://upload.wikimedia.org", grant("https://upload.wikimedia.org")],
      ]),
    });
    const [candidate] = await discover(universityFixture(), ["campus"], contextFixture());
    expect(searches).toEqual(['web:site:example.edu "atrium" Example University']);
    expect(fetched).toEqual([category, target, corroboration]);
    expect(candidate).toMatchObject({ imageUrl: targetOriginal, policy: { display: "direct_permitted", retention: "transient_only",
      attributionText: "Campus Photographer — CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" } });
    expect(candidate.evidence[0]).toMatchObject({ authority: "attributable", association: "explicit",
      corroboration: 20, independentEquivalent: true });
  });
  it.each(["denied-first", "irrelevant-first", "both-denied", "both-irrelevant", "first-supports",
    "diverse-success", "diverse-first-supports", "diverse-all-denied"] as const)(
    "bounds official corroboration and prefers distinct origins: %s", async mode => {
      const diverse = mode.startsWith("diverse-");
      const firstSupports = mode === "first-supports" || mode === "diverse-first-supports";
      const allDenied = mode === "both-denied" || mode === "diverse-all-denied";
      const firstDenied = mode === "denied-first" || mode === "diverse-success" || allDenied;
      const filePath = "/wiki/File:Campus_atrium.jpg";
      const original = "https://upload.wikimedia.org/commons/atrium.jpg";
      const officialAttempts: string[] = [], searches: string[] = [];
      const transport = await transportFixture((request, response) => {
        if (request.url === "/robots.txt") {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(request.headers.host === "example.edu" || request.headers.host === "research.example.edu"
            ? `User-agent: *\n${firstDenied ? "Disallow: /first\n" : ""}${allDenied ? "Disallow: /second\nDisallow: /third\n" : ""}`
            : "User-agent: *\nAllow: /\n"); return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        if (request.url?.startsWith("/wiki/Category:")) {
          response.end(`<a href="${filePath}">Atrium</a><a href="/wiki/File:Other_atrium.jpg">Another atrium</a>`);
        } else if (request.url?.startsWith("/wiki/File:")) {
          response.end(`<div class="fullMedia"><a class="internal" href="${original}">Original</a></div>
            <table><tr><td id="fileinfotpl_desc">Description</td><td>Example University, main atrium. Example City, KZ</td></tr>
            <tr><td id="fileinfotpl_aut">Author</td><td>Fixture Photographer</td></tr></table>
            <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`);
        } else {
          const supports = mode !== "both-irrelevant" && (request.url !== "/first" || firstSupports);
          response.end(`<figure><img src="/photo.jpg"><figcaption>${supports ? "Our main atrium welcomes visitors." : "Our sports field welcomes visitors."}</figcaption></figure>`);
        }
      });
      try {
        const safeFetch = createSafeFetcher({ contactUrl: "https://visual-profile-project.org/contact",
          resolve: async () => [{ address: "93.184.216.34", family: 4 }], connect: transport.connector }).safeFetch;
        const ctx = contextFixture();
        // One case leaves exactly four dispatches for category, file and two official pages.
        for (let index = 0; index < (mode === "irrelevant-first" ? 8 : 2); index++) await safeFetch(`https://identity.edu/${index}`, "html", ctx);
        const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "transient_only" as const,
          display: "direct_permitted" as const, basis: ["Documented publisher reuse terms"] });
        const discover = createDiscoveryPlanner({
          fetchPage: (url, context) => {
            if (context.publisherPhase === "official_corroboration") officialAttempts.push(url);
            return safeFetch(url, "html", context);
          },
          search: async input => {
            if (input.kind !== "web") return [];
            searches.push(input.query);
            return ["https://example.edu/first", "https://outsider.org/first", "https://example.edu.attacker.com/second",
              "https://attacker-example.edu/first", "https://example.edu/second",
              ...(diverse ? ["https://research.example.edu/third"] : []),
              "https://example.edu/third", "https://research.example.edu/fourth"]
              .filter(url => diverse || !url.includes("research.example.edu"))
              .map(pageUrl => ({ pageUrl, policy: { ...grant("brave"), display: "link_only" as const } }));
          },
          publisherPolicies: new Map(["https://commons.wikimedia.org", "https://upload.wikimedia.org"].map(origin => [origin, grant(origin)])),
        });
        const result = await discover(universityFixture(), ["campus"], ctx).catch(error => error);
        expect(officialAttempts).toEqual(firstSupports ? ["https://example.edu/first"]
          : diverse ? ["https://example.edu/first", "https://research.example.edu/third",
            ...(allDenied ? ["https://example.edu/second"] : [])]
          : ["https://example.edu/first", "https://example.edu/second"]);
        expect(searches).toEqual(['site:example.edu "atrium" Example University']);
        const paths = transport.requests.filter(request => request.host === "example.edu").map(request => request.path);
        expect(paths).toEqual(allDenied || mode === "diverse-success" ? ["/robots.txt"] : mode === "denied-first"
          ? ["/robots.txt", "/second"] : firstSupports ? ["/robots.txt", "/first"] : ["/robots.txt", "/first", "/second"]);
        expect(transport.requests.filter(request => request.host === "research.example.edu").map(request => request.path))
          .toEqual(!diverse || firstSupports ? [] : allDenied ? ["/robots.txt"] : ["/robots.txt", "/third"]);
        expect(transport.requests.some(request => request.host?.includes("outsider") || request.host?.includes("attacker"))).toBe(false);
        if (allDenied || mode === "both-irrelevant") {
          // Subsequent files for the same object must not restart the bounded allowance.
          if (allDenied) expect(result).toMatchObject({ code: "access_denied" });
          else {
            expect(result).toHaveLength(1);
            expect(result[0].evidence[0]).toMatchObject({ independentEquivalent: false, corroboration: 0 });
          }
        } else {
          expect(result[0]).toMatchObject({ imageUrl: original, evidence: [expect.objectContaining({
            association: "explicit", independentEquivalent: true, corroboration: 20,
            corroborationSources: [expect.objectContaining({ source: expect.objectContaining({ url: firstSupports
              ? "https://example.edu/first" : diverse ? "https://research.example.edu/third" : "https://example.edu/second" }), independent: true })],
          })] });
        }
        if (mode === "irrelevant-first") {
          expect(transport.requests.filter(request => request.path !== "/robots.txt")).toHaveLength(12);
          await expect(safeFetch("https://example.edu/thirteenth", "html", ctx)).rejects.toMatchObject({ code: "budget_exhausted" });
          expect(transport.requests.some(request => request.path === "/thirteenth")).toBe(false);
        }
      } finally { await transport.close(); }
    });
  it("completes the real-like licensed chain after two identity pages and stops at the first corroborated file", async () => {
    const categoryPath = "/wiki/Category:Example_University";
    const files = Array.from({ length: 7 }, (_, index) => `/wiki/File:Campus_view_${index + 1}.jpg`);
    const original = (index: number) => `https://upload.wikimedia.org/commons/campus-${index}.jpg`;
    const category = `<div class="gallery">${files.map(file => `<a href="${file}">Campus file</a>`).join("")}</div>`;
    const filePage = (index: number) => `<h1>File page</h1><div class="fullMedia"><a class="internal" href="${original(index)}">Original file</a></div>
      <table><tr><td id="fileinfotpl_desc">Description</td><td>Example University, ${index === 5 ? "main atrium" : "campus view"}. Example City, KZ</td></tr>
      <tr><td id="fileinfotpl_aut">Author</td><td>Fixture Photographer ${index}</td></tr></table>
      <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`;
    const transport = await transportFixture((request, response) => {
      if (request.url === "/robots.txt") { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "text/html" });
      if (request.headers.host === "commons.wikimedia.org" && request.url === categoryPath) response.end(category);
      else if (request.headers.host === "commons.wikimedia.org" && files.includes(request.url!)) response.end(filePage(files.indexOf(request.url!)));
      else if (request.headers.host === "example.edu" && request.url === "/news/atrium") response.end('<figure><img src="/news.jpg"><figcaption>Our beautiful main atrium welcomes campus visitors.</figcaption></figure>');
      else response.end("<main>Identity page</main>");
    });
    try {
      const safeFetch = createSafeFetcher({ contactUrl: "https://visual-profile-project.org/contact",
        resolve: async () => [{ address: "93.184.216.34", family: 4 }], connect: transport.connector }).safeFetch;
      const ctx = { ...contextFixture(), publisherPhase: "identity" as const };
      await safeFetch("https://example.edu/identity-1", "html", ctx);
      await safeFetch("https://example.edu/identity-2", "html", ctx);
      const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "cache_permitted" as const,
        display: "direct_permitted" as const, basis: ["Documented Wikimedia reuse and direct-display terms"] });
      const discover = createDiscoveryPlanner({ fetchPage: (url, context) => safeFetch(url, "html", context),
        search: async input => input.kind === "web" ? [{ pageUrl: "https://example.edu/news/atrium", policy: {
          origin: "brave", policyVersion: "v1", retention: "transient_only", display: "link_only", basis: ["Brave discovery"],
        } }] : [], publisherPolicies: new Map([
          ["https://commons.wikimedia.org", grant("https://commons.wikimedia.org")],
          ["https://upload.wikimedia.org", grant("https://upload.wikimedia.org")],
        ]) });
      const university = { ...universityFixture(), officialDomains: ["example.edu"] };
      const candidates = await discover(university, ["campus"], ctx);
      expect(transport.requests.filter(request => request.path !== "/robots.txt").map(request => `${request.host}${request.path}`)).toEqual([
        "example.edu/identity-1", "example.edu/identity-2", `commons.wikimedia.org${categoryPath}`,
        ...files.slice(0, 6).map(file => `commons.wikimedia.org${file}`), "example.edu/news/atrium",
      ]);
      expect(candidates[0]).toMatchObject({ imageUrl: original(5), evidence: [expect.objectContaining({
        independentEquivalent: true, corroboration: 20,
      })] });
    } finally { await transport.close(); }
  });
  it("uses one relevant Commons subcategory and corroborates its named campus within the existing budget", async () => {
    const root = "https://commons.wikimedia.org/wiki/Category:Example_University";
    const campus = "https://commons.wikimedia.org/wiki/Category:Example_University,_North_campus";
    const target = "https://commons.wikimedia.org/wiki/File:Example_University,_North_campus_2025.jpg";
    const original = "https://upload.wikimedia.org/commons/north-campus.jpg";
    const official = "https://example.edu/campus/north";
    const irrelevant = Array.from({ length: 12 }, (_, index) => `/wiki/File:Archive_item_${index + 1}.jpg`);
    const campusFiles = Array.from({ length: 12 }, (_, index) => `/wiki/File:Campus_view_${index + 1}.jpg`);
    const filePage = (description: string) => `<div class="fullMedia"><a class="internal" href="${original}">Original</a></div>
      <table><tr><td id="fileinfotpl_desc">Description</td><td>${description}</td></tr>
      <tr><td id="fileinfotpl_aut">Author</td><td>Fixture Photographer</td></tr></table>
      <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`;
    const pages = new Map<string, string>([
      [root, `<a href="/wiki/Category:Example_University,_North_campus">North campus</a>
        ${irrelevant.map(path => `<a href="${path}">Archive</a>`).join("")}`],
      [campus, `${campusFiles.map(path => `<a href="${path}">Campus view</a>`).join("")}
        <a href="/wiki/Category:Example_University,_Interiors">Interiors</a>
        <a href="${new URL(target).pathname}">North campus photo</a>`],
      [target, filePage("A view from the North campus of Example University. Example City, KZ")],
      [official, "<main><h1>Campuses</h1><p>Our North campus welcomes students.</p></main>"],
    ]);
    const fetched: string[] = [];
    const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "cache_permitted" as const,
      display: "direct_permitted" as const, basis: ["Documented Wikimedia reuse and direct-display terms"] });
    const discover = createDiscoveryPlanner({
      fetchPage: async url => { fetched.push(url); return { ...publisherFixture(pages.get(url) ?? "<main>Irrelevant</main>"), finalUrl: url }; },
      search: async input => input.kind === "web" ? [{ pageUrl: official, policy: {
        origin: "search", policyVersion: "v1", retention: "transient_only", display: "link_only", basis: ["Discovery only"],
      } }] : [],
      publisherPolicies: new Map([
        ["https://commons.wikimedia.org", grant("https://commons.wikimedia.org")],
        ["https://upload.wikimedia.org", grant("https://upload.wikimedia.org")],
      ]),
    });

    const candidates = await discover(universityFixture(), ["campus"], contextFixture());

    expect(fetched).toEqual([root, campus, target, official]);
    expect(fetched.some(url => irrelevant.some(path => url.endsWith(path)))).toBe(false);
    expect(fetched.some(url => campusFiles.some(path => url.endsWith(path)))).toBe(false);
    expect(candidates[0]).toMatchObject({ imageUrl: original, evidence: [expect.objectContaining({
      independentEquivalent: true, corroboration: 20,
    })] });
  });
  it("does not treat official navigation text as object corroboration", async () => {
    const root = "https://commons.wikimedia.org/wiki/Category:Example_University";
    const file = "https://commons.wikimedia.org/wiki/File:Example_University_main_atrium.jpg";
    const original = "https://upload.wikimedia.org/commons/main-atrium.jpg";
    const official = "https://example.edu/about";
    const pages = new Map<string, string>([
      [root, `<a href="${new URL(file).pathname}">Main atrium</a>`],
      [file, `<div class="fullMedia"><a class="internal" href="${original}">Original</a></div>
        <table><tr><td id="fileinfotpl_desc">Description</td><td>The main atrium of Example University. Example City, KZ</td></tr>
        <tr><td id="fileinfotpl_aut">Author</td><td>Fixture Photographer</td></tr></table>
        <span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span>`],
      [official, "<nav>Visit our main atrium</nav><main>General university information.</main>"],
    ]);
    const fetched: string[] = [];
    const grant = (origin: string) => ({ origin, policyVersion: "v1", retention: "cache_permitted" as const,
      display: "direct_permitted" as const, basis: ["Documented Wikimedia reuse and direct-display terms"] });
    const discover = createDiscoveryPlanner({
      fetchPage: async url => { fetched.push(url); return { ...publisherFixture(pages.get(url) ?? "<main>Irrelevant</main>"), finalUrl: url }; },
      search: async input => input.kind === "web" ? [{ pageUrl: official, policy: {
        origin: "search", policyVersion: "v1", retention: "transient_only", display: "link_only", basis: ["Discovery only"],
      } }] : [],
      publisherPolicies: new Map([
        ["https://commons.wikimedia.org", grant("https://commons.wikimedia.org")],
        ["https://upload.wikimedia.org", grant("https://upload.wikimedia.org")],
      ]),
    });

    const candidates = await discover(universityFixture(), ["campus"], contextFixture());

    expect(fetched).toEqual([root, file, official]);
    expect(candidates[0]).toMatchObject({ imageUrl: original });
    expect(candidates[0]?.evidence[0]?.independentEquivalent).not.toBe(true);
  });
});
