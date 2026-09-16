# Visual University Profile: 72-Hour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an automatic, source-backed university photo profile that works for unfamiliar universities, returns useful results in about 30 seconds, and keeps prototype spending preferably below USD 10.

**Architecture:** One Next.js application with Node.js server routes coordinates bounded identity resolution, official-first discovery, original-publisher evidence, safe image processing, AI interpretation and deterministic acceptance. A single POST streams NDJSON to the browser; shared Redis counters protect spending across instances. No worker service, ingestion platform or hidden university dataset is required.

**Tech Stack:** TypeScript, Next.js App Router, React, Node.js, Brave Web/Image Search, Wikidata, OpenAI Responses through a provider interface, sharp, undici, Cheerio, Zod, ipaddr.js, robots-parser, Upstash Redis, Vitest and Playwright. Use pnpm and commit its lockfile. Use a supported Node LTS accepted by the selected host; first candidate is Node 22. No additional UI framework is needed.

**Spec:** [Approved design](../specs/2026-09-16-visual-university-profile-design.md), approved after commit `1b162ac`. Read the entire spec before executing. The official four-page LOCUS PDF identified in spec §1 remains the case authority. Its SHA-256 is `723F451EB2F2FA9D6B21108233B2CE55F4EE8839C3111700802CCCD6E285B02D`.

## Global Constraints

The following requirements are copied verbatim from the approved spec; they apply to every task.

- “Next.js and TypeScript, including server-side routes, match the team's skills.”
- “Optimize for a 72-hour MVP and preferably less than USD 10 total prototype spending. Credits, account access and hosting eligibility are not assumed until checked.”
- “Kazakhstan is the primary evaluation focus; university support must not depend on a fixed university list.”
- “Quality, traceable evidence and honest gaps take priority over image count.”
- “No hidden manual curation, fabricated sources, fake timing, generated campus substitutes or stock images presented as the selected campus.”
- “No API keys in source control or browser bundles.”
- “Set Brave Web and Image Search `safesearch` explicitly to `strict`; do not depend on endpoint defaults (R3).”
- “The server has an absolute 27-second processing deadline from receipt of a generation request, reserving approximately three seconds for delivery and browser rendering.”
- “Initial AI ceilings are USD 0.02 per normal profile and USD 0.04 per profile when evaluated escalation is enabled. Set a separate aggregate AI usage allowance within the funded balance, initially USD 4, leaving reconciliation headroom.”
- “Shared counters survive serverless instances. If the shared budget store fails, fail closed for fresh paid work; an eligible cached response can still be served if reachable.”

Additional exact design values, collected here so tasks cannot quietly diverge:

| Control | Required value or behavior |
| --- | --- |
| Categories | `campus`, `dormitory`, `classrooms`, `library`, `laboratories`, `sport`, `student_life`, `city` |
| Base categories | Campus, dormitory, classrooms, library, city; all must have visible verified photos for `complete` |
| Discovery | Target 6–8 Brave requests; maximum 10 including retries; official attempt before broader fallback |
| Retrieval | 8 publisher content pages; 8 origin-policy checks; 6 concurrent outbound requests and 2 per host; stricter publisher pacing wins |
| Media | Approximately 3-second fetch timeout within the absolute deadline; 2 MB decoded HTML; 5 MB compressed raster; 20 megapixels decoded |
| Candidate work | 40 metadata candidates; 24 downloads; 16 normal vision images; at most 8 images per batch |
| AI payload | Long edge at most 1,024 pixels; at most 512 KiB per derivative; complete encoded request at most 8 MiB or lower provider limit |
| AI calls | At most 2 simultaneous; 2 primary vision calls, each at most 10 seconds; description at most 4 seconds; optional resolver at most 2 seconds |
| Initial model | `gpt-5.6-luna`; model/provider configurable; no silent substitution; Terra escalation disabled |
| Global admission | 3 active generation pipelines; no waiting queue |
| Session admission | Server-issued anonymous session; bucket capacity 10, refill 20/minute, 1 active generation per session |
| Shared-network guard | 120 submitted profile requests per IP per rolling minute; no 3/minute/IP rule |
| Dedup baseline | 64-bit perceptual hash; Hamming distance ≤6 proposes comparison; aspect ratios within 5%; SSIM ≥0.95 on common 128-pixel-long-edge grayscale images |
| Score | Authority 25/15/0; attribution 45/25/10/0; independent corroboration 20/10/0; visual consistency 10/5/0 |
| Labels | 80–100 and every gate: verified; 60–79: opt-in uncertain; below 60: withheld; hard rejection overrides score |
| Retention | `transient_only` by default; `cache_permitted` only with explicit basis; `disallowed` excluded; derived data inherits restrictions |
| Eligible cache ceilings | Identity 7 days; publisher/profile 24 hours or less; assessment no longer than supporting evidence |
| Delivery | Permitted screened remote images directly; no persistent proxy, framework optimization, object-storage or service-worker image cache |

---

## Execution boundary and 72-hour order

This document is a plan, not authorization to execute it now. No app code, dependency installation, API calls with credentials, account creation, purchase or deployment is performed by writing it. The latest user approval authorizes this planning step and supersedes the historical planning stop recorded in the spec. The approved architecture is retained.

At execution start, calculate available time as the smaller of 72 hours and the time remaining before **19 September 2026, 12:00 Astana time**. Do not assume a fresh 72 hours after reading this plan. Cut secondary scope and preserve release time if the remaining window is shorter. Treat estimates as timeboxes, not measured implementation times.

### MUST-HAVE MVP milestone order

| Milestone | Elapsed target | Tasks | Observable exit gate |
| --- | --- | --- | --- |
| **M1 — Smallest real deployed vertical slice** | **0–12 hours** | 1–5 | Typed university query → live resolution → real discovery → fetched original-source evidence → one image safely fetched, classified and verified → NDJSON API response → visible photo, source and score in browser on the deployment |
| **M2 — Full case path, redeployed** | 12–30 hours | 6–8 | General alias/campus resolution, all eight category sections and filters, exact/ordinary near-duplicate removal, source dates, cited campus description, honest gaps; functioning deployed end-to-end MVP |
| **M3 — Deadline and failure reliability** | 30–44 hours | 9 | Cancellation, provider failures, shared-network fairness, global budgets and retention checked; updated deployment still works cold |
| **M4 — Release checks and bounded live acceptance** | 44–58 hours | 10–11 | CI green on release candidate; cold/holdout/concurrent checks and sampled decisions documented; known false verification fixed or release blocked |
| **M5 — Submission-ready package and buffer** | 58–66 hours; 66–72 reserved | 12 | Accessible product/repository, README/disclosure, ≤3-minute demo, ≤8-slide PDF; final checks and deadline freeze |

M1 is the first milestone. Its five tasks are small integration steps, not separate infrastructure milestones. Deploy the capability check during its first 60–90 minutes, then build the real data path. By hour 6, inspect whether a real source/image has reached the backend; if not, stop styling and extra source heuristics to fix the integration blocker. Do not spend the first day building caches, generic frameworks or an evaluation platform.

If M1 misses its timebox, record the actual blocker and revised time remaining. Do not call a mocked response, source-only card, uncertain photo or locally working page a completed vertical slice. A legitimately permitted and evidenced live image is required. No university-specific fallback data may be added to make that gate pass.

After every task: run its focused checks, commit that coherent change, and preserve the working path. Deploy at M1, M2 and after relevant M3/M4 fixes. Install and pin dependencies when first needed; do not start with every proposed dependency. The development workflow is RED → observed behavioral failure → minimal implementation → GREEN → small refactor → commit. If a test initially fails to import a missing module, add only its typed shell and rerun until the assertion fails for the intended missing behavior before implementing it.

## File map and ownership

Paths below are relative to the repository root. They are planned files, not existing implementation. `src/` keeps server responsibilities small; importing `server-only` in server entry modules prevents accidental client bundling. Test utilities never enter production code.

| Files | Responsibility / first task |
| --- | --- |
| `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example` | Minimal application/tool configuration, Task 1 |
| `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` | Browser shell and search page, Tasks 1/5 |
| `src/app/api/capabilities/route.ts`, `scripts/probe-host.ts` | Protected temporary host-capability probe, Task 1; disabled before release |
| `src/lib/contracts.ts`, `src/lib/events.ts`, `src/lib/event-schema.ts` | Shared records, wire envelope and runtime schema, Tasks 1/5 |
| `src/server/config.ts`, `src/server/limits.ts` | Validated server configuration and request-wide limits, Task 1 |
| `src/server/fetch/safe-fetch.ts`, `src/server/fetch/access-policy.ts` | Pinned public-address transport, bounded body reads, robots/publisher access, Task 2 |
| `src/server/sources/publisher.ts`, `src/server/sources/usage-policy.ts` | Original-page evidence, image association, use/retention basis, Task 2 |
| `src/server/usage/ledger.ts`, `src/server/usage/ledger.lua` | Shared atomic admission/reservations/reconciliation, Task 3 |
| `src/server/discovery/brave.ts`, `src/server/discovery/wikidata.ts`, `src/server/discovery/resolver.ts`, `src/server/discovery/planner.ts`, `src/server/discovery/selection.ts` | Live identity, official-first source discovery and authenticated campus selection, Tasks 3/6 |
| `src/server/images/prepare.ts`, `src/server/images/deduplicate.ts` | Validated bytes, exact hashes, ordinary perceptual deduplication, Tasks 4/7 |
| `src/server/ai/adapter.ts`, `src/server/ai/openai.ts`, `src/server/ai/assessment-schema.ts` | Provider-neutral contract, Luna implementation, schema and reference validation, Task 4 |
| `src/server/policy/decide.ts`, `src/server/profile/assemble.ts`, `src/server/profile/description.ts` | Deterministic scoring/coverage and cited facts, Tasks 4/5/8 |
| `src/server/profile/run-profile.ts`, `src/server/profile/services.ts` | Deadline-aware orchestration and concrete dependency wiring, Tasks 5/9 |
| `src/app/api/session/route.ts`, `src/app/api/profile/route.ts` | Session issuance, request validation and NDJSON response, Task 5 |
| `src/components/SearchForm.tsx`, `src/components/ProfileView.tsx`, `src/components/ImageCard.tsx`, `src/lib/read-events.ts` | Search, stream consumption, accessible gallery and delivery failures, Tasks 5/8 |
| `src/server/cache/policy-cache.ts`, `src/server/telemetry.ts` | Small eligible cache boundary and metadata-only metrics, Task 9 |
| `tests/unit/*.test.ts`, `tests/integration/*.test.ts`, `tests/e2e/*.spec.ts`, `tests/support/fixtures.ts` | Named tests below; authored/rights-permitted fixtures only |
| `playwright.config.ts`, `.github/workflows/ci.yml`, `scripts/scan-secrets.mjs` | Offline CI/release verification, Task 10 |
| `scripts/live-acceptance.ts`, `docs/validation/hosting.md`, `docs/validation/live-acceptance.md` | Bounded execution evidence without restricted payloads, Tasks 1/11 |
| `README.md`, `docs/submission/demo-script.md`, `docs/submission/slides.md`, `docs/submission/release-checklist.md`, `deliverables/locus-case-01.pdf` | Case delivery materials, Task 12 |

## Shared interfaces and data boundaries

Task 1 establishes these contracts as the first consumer needs them; later tasks implement them without renaming fields locally. Runtime schemas must reject unknown fields at external boundaries. Dates are ISO-8601 UTC strings and numbers are finite. Domain failures use normalized codes, never provider payloads or credentials.

Bound URLs to 2,048 characters, publisher excerpts to 2,000 characters each, human-facing reason text to 300 characters per reason and arrays to the request limits. Enforce encoded frame/request limits even when individual fields pass validation. Module contracts may be declared before their behavior is needed; do not manufacture results to satisfy a still-unused interface.

```ts
export const categories = ["campus", "dormitory", "classrooms", "library",
  "laboratories", "sport", "student_life", "city"] as const;
export type Category = typeof categories[number];
export type Retention = "transient_only" | "cache_permitted" | "disallowed";
export type Stage = "resolving" | "official_retrieval" | "fallback_retrieval"
  | "checking" | "assembling";
export type TerminalState = "needs_selection" | "not_found" | "complete"
  | "partial" | "insufficient_evidence" | "unavailable";
export type FailureCode = "invalid_request" | "busy" | "budget_exhausted"
  | "dependency_unavailable" | "invalid_provider_output" | "deadline"
  | "cancelled" | "unsafe_target" | "access_denied" | "invalid_media"
  | "policy_unknown" | "protocol_error";
export interface UsagePolicy {
  retention: Retention; origin: string; policyVersion: string;
  basis: string[]; expiresAt?: string;
  display: "direct_permitted" | "link_only" | "disallowed";
  attributionText?: string;
}
export interface SourceRef {
  id: string; url: string; retrievedAt: string;
  publishedAt?: string; capturedAt?: string;
  dateBasis?: string; policy: UsagePolicy;
}
export interface University {
  id: string; name: string; aliases: string[]; campus: string;
  city: string; country: string; officialDomains: string[];
  sources: SourceRef[];
}
export interface ProfileQuery {
  query: string; countryHint: string; selectionToken?: string;
}
export type Resolution =
  | { kind: "resolved"; university: University }
  | { kind: "needs_selection"; choices: Array<{
      name: string; campus: string; city: string; country: string;
      officialDomain: string; source: SourceRef; selectionToken: string;
    }> }
  | { kind: "not_found" }
  | { kind: "unavailable"; code: FailureCode };
export interface Evidence {
  source: SourceRef; imageId: string; imageUrl: string;
  excerpt: string; association: "explicit" | "gallery" | "mention" | "none";
  authority: "official" | "attributable" | "unknown";
  locationSupported: boolean; categorySupported: boolean;
  officialDirect: boolean; independentEquivalent: boolean;
  corroboration: 20 | 10 | 0; corroborationEvidenceIds: string[];
  conflict: boolean; forbidden: boolean;
}
export interface Candidate {
  id: string; imageUrl: string; pageUrl: string; evidence: Evidence[];
  categoryHint?: Category; policy: UsagePolicy;
}
export interface ValidatedImage {
  imageId: string; mediaType: "image/jpeg"; bytes: Uint8Array;
  byteLength: number; width: number; height: number; sha256: string;
}
export interface PreparedCandidate {
  candidate: Candidate; image: ValidatedImage;
  sourceSha256: string; perceptualHash?: string;
}
export interface Assessment {
  imageId: string; category: Category; tags: Category[];
  visual: 10 | 5 | 0; cues: string[]; evidenceIds: string[];
  safety: "clear" | "unsafe" | "unresolved";
  relevance: "relevant" | "irrelevant" | "unresolved";
  conflict: boolean; stockOrRender: boolean;
  provider: string; model: string; promptVersion: string; schemaVersion: string;
}
export interface Decision {
  imageId: string; status: "verified" | "uncertain" | "withheld" | "rejected";
  score: number; components: { authority: number; attribution: number;
    corroboration: number; visual: number };
  reasons: string[]; category: Category; tags: Category[];
}
export interface ImageCardData {
  id: string; revision: number; category: Category; tags: Category[];
  status: "verified" | "uncertain"; score: number;
  components: Decision["components"]; reasons: string[];
  source: SourceRef; displayUrl?: string;
  delivery: "remote" | "missing" | "not_permitted";
}
export interface Claim { text: string; evidenceIds: string[]; campusFact: boolean }
export interface Profile {
  university: University; cards: ImageCardData[]; description: Claim[];
  sources: SourceRef[]; gaps: Partial<Record<Category, string>>;
  state: "complete" | "partial" | "insufficient_evidence" | "unavailable";
  verifiedBaseCategories: number; warnings: FailureCode[];
  provenance: "live" | "eligible_cache"; elapsedMs: number;
}
export interface RunContext {
  requestId: string; startedAt: number; deadlineAt: number;
  signal: AbortSignal; sessionId: string; ipHash: string;
}
export interface AiUsage { inputTokens: number; outputTokens: number;
  costMicrousd: number; provider: string; model: string }
export interface AiAdapter {
  capabilities: { imageInput: true; structuredOutput: true;
    cancellation: true; usageAccounting: true };
  assess(input: { university: University; images: ValidatedImage[];
    evidence: Evidence[] }, ctx: RunContext):
    Promise<{ assessments: Assessment[]; usage: AiUsage }>;
  describe(input: { university: University; facts: Claim[];
    sources: SourceRef[] }, ctx: RunContext):
    Promise<{ claims: Claim[]; usage: AiUsage }>;
}
```

No `ValidatedImage`, raw provider result or internal excerpt appears on the wire. Types do not by themselves prove safety: only `prepareImage` can create a validated payload, and the adapter rechecks byte limits/hash/media metadata at its boundary. It must not accept a structurally similar object with an HTTP URL replacing bytes.

### Streaming decision: POST + streamed NDJSON

Use `POST /api/profile`, JSON body `ProfileQuery`, `Content-Type: application/json`; ordinary request body maximum 2 KiB and normalized query length 2–160 characters. A selection request may use at most 12 KiB including its maximum 8 KiB authenticated token. Bound incoming reads at 12 KiB before parsing, then reject a body over 2 KiB unless it contains a valid selection token. Browser obtains a server-issued session cookie from `POST /api/session` before its first generation. Validate `Origin` against the deployment origin, reject cross-site calls, and use an HttpOnly/Secure/SameSite=Lax signed session cookie. No accounts or browser-visible API keys.

Response: `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-store, no-transform`, `X-Content-Type-Options: nosniff`. Every frame is one UTF-8 JSON object followed by `\n`; no multiline JSON and no raw data frames. Hosting must demonstrate that compression/proxy buffering does not delay delivery. NDJSON is simpler here because ordinary `fetch` sends the existing POST body and reads lines with one parser. SSE also works with fetch, but EventSource's GET/reconnection conveniences are not needed and must not trigger paid replay.

```ts
export interface EventPayloads {
  stage: { stage: Stage };
  identity: { university: University };
  clarification: { choices: Extract<Resolution,
    { kind: "needs_selection" }>["choices"] };
  image: { card: ImageCardData };
  warning: { code: FailureCode; message: string; category?: Category };
  final: { state: TerminalState; profile: Profile | null; elapsedMs: number };
  fatal: { code: FailureCode; message: string; retryAfterSeconds?: number };
}
export type ProfileEvent = { [K in keyof EventPayloads]: {
  v: 1; requestId: string; seq: number; type: K; data: EventPayloads[K]
} }[keyof EventPayloads];
export type EventBody = { [K in keyof EventPayloads]: {
  type: K; data: EventPayloads[K]
} }[keyof EventPayloads];
export type Emit = (event: EventBody) => void;
```

- Server assigns a UUID request ID and contiguous sequence starting at 1. `stage` records actual work; no fake percentage. `identity` precedes image cards. `clarification` is followed by `final` with `needs_selection` and null profile. Unknown input completes with `not_found` only after discovery actually finishes.
- `image` is an upsert by card ID with strictly increasing revision. It contains a verified or safely displayable uncertain decision; never an unchecked candidate. A later revision may remove a display URL and report missing delivery. Final profile is authoritative for server coverage.
- Exactly one of `final` or `fatal` terminates the stream; no event is emitted afterward. Before a stream starts, HTTP 400/429/503 returns a one-line `fatal` envelope and an applicable `Retry-After`; after headers are sent, fatal errors use the stream. Expected lack of evidence is a `final` state, not a protocol error.
- `final` uses null profile for selection/not-found/unavailable before identity; otherwise state and profile must agree. `fatal` is reserved for invalid requests/admission or an unexpected failure that prevents a coherent final result.
- Parser uses streaming `TextDecoder`, retaining the incomplete tail across chunks. Validate every frame against the strict discriminated schema. Maximum line 256 KiB, entire stream 2 MiB; do not keep raw lines after parsing. Reject sequence gaps, mismatched request IDs, malformed/oversized lines, invalid source URLs and frames after terminal. Ignore already-seen sequence numbers and stale card revisions; a new search aborts the previous request and ignores its late events.
- A valid final frame must end with a newline. EOF without a terminal event is a connection failure even if cards arrived; keep already accepted cards and label the result interrupted/partial, never complete. Abort on explicit cancel, replacement search, unmount or parser failure. Cancellation aborts server fetches/model calls and releases the admission lease; conservatively retain unknown billing reservations.
- No automatic reconnect or automatic new generation after a failed stream. A visible Retry button starts one new explicitly initiated request. Do not auto-retry a POST after a network error.

Example framing (each displayed line is a complete JSON record):

```jsonl
{"v":1,"requestId":"e3811aae-9ec9-4bbb-a32f-b62af38f4337","seq":1,"type":"stage","data":{"stage":"resolving"}}
{"v":1,"requestId":"e3811aae-9ec9-4bbb-a32f-b62af38f4337","seq":2,"type":"warning","data":{"code":"deadline","message":"Retrieval stopped at the request deadline."}}
{"v":1,"requestId":"e3811aae-9ec9-4bbb-a32f-b62af38f4337","seq":3,"type":"final","data":{"state":"unavailable","profile":null,"elapsedMs":27000}}
```

A deployment probe uses a separate small frame schema and never masquerades as a university profile.

## MUST-HAVE MVP tasks

### Task 1: Establish the browser shell and prove the chosen host can run the slice

**Milestone/timebox:** M1, first 60–90 minutes. The deliverable is a deployed capability result, not a reusable infrastructure platform.

**Files:** Create the configuration files, app shell, contracts/limits/config, capability route and probe script in the file map; `tests/unit/limits.test.ts`; `docs/validation/hosting.md`.

**Interfaces:** Produce `remainingMs(ctx: RunContext, now: number): number`; `makeContext(input: { requestId: string; sessionId: string; ipHash: string; signal: AbortSignal; now: number }): RunContext`; `GET(request: Request): Promise<Response>` in the capability route. The initial page is a search shell; Task 5 connects real generation.

- [ ] Confirm existing Git status and available time. Inspect actual account access, credits and hosting eligibility without printing keys. Record Node/runtime/account choice, current provider pricing and allowed usage. No account creation or spending is implicit in a documentation task; at execution, use already authorized accounts and funded limits. Missing credentials are a live-integration blocker, not permission to substitute mocks in the demo.
- [ ] Add the minimal package configuration below, install only its packages plus the named test/compiler types, and commit exact resolved versions in `pnpm-lock.yaml`. Set `engines.node` to the host-tested LTS and use that version in CI. Preserve existing `docs/` and Git history; do not run a scaffolder that overwrites the repository.

```json
{
  "name": "visual-university-profile", "private": true,
  "scripts": {
    "dev": "next dev", "build": "next build", "start": "next start",
    "lint": "eslint .", "typecheck": "next typegen && tsc --noEmit",
    "test": "vitest run", "test:watch": "vitest",
    "probe:host": "tsx scripts/probe-host.ts"
  }
}
```

```sh
pnpm add --save-exact next react react-dom sharp server-only zod
pnpm add -D --save-exact typescript @types/node @types/react @types/react-dom eslint eslint-config-next vitest tsx
```

- [ ] Configure strict TypeScript, the `@/*` alias to `src/*`, Vitest's same alias, Node test environment and flat ESLint Next configuration. Ignore `.env*` except `.env.example`, `.next/`, `node_modules/`, `.vercel/`, test reports and temporary live artifacts. `.env.example` contains names with empty values only: `BRAVE_API_KEY`, `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SESSION_SECRET`, `CRAWLER_CONTACT_URL`, `CAPABILITY_PROBE_TOKEN`; non-secret defaults are `AI_MODEL=gpt-5.6-luna`, `AI_ALLOWANCE_MICROUSD=4000000`, `AI_PROFILE_CAP_MICROUSD=20000`, `BRAVE_PAID_OVERAGE=false`, `CAPABILITY_PROBE_ENABLED=false`, `CACHE_READ_ENABLED=true`.
- [ ] RED: write the budget-deadline behavior test before the helper. It catches starting with a fresh timeout after work has already consumed the request window.

```ts
it("does not replenish the absolute request deadline", () => {
  const ctx = makeContext({ requestId: "r", sessionId: "s", ipHash: "i",
    signal: new AbortController().signal, now: 1_000 });
  expect(remainingMs(ctx, 26_000)).toBe(2_000);
  expect(remainingMs(ctx, 29_000)).toBe(0);
});
```

- [ ] Run `pnpm test tests/unit/limits.test.ts`; require the expected failing time assertion against the typed shell.
- [ ] GREEN: implement the absolute deadline and immutable shared limits. Add only a minimal root layout and page needed to deploy.

```ts
export function makeContext(input: { requestId: string; sessionId: string;
  ipHash: string; signal: AbortSignal; now: number }): RunContext {
  return { requestId: input.requestId, sessionId: input.sessionId,
    ipHash: input.ipHash, signal: input.signal,
    startedAt: input.now, deadlineAt: input.now + 27_000 };
}
export function remainingMs(ctx: RunContext, now: number): number {
  return Math.max(0, ctx.deadlineAt - now);
}
```

- [ ] Add a token-protected capability route with `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 60`, `Cache-Control: no-store`, and no arbitrary URL input. It must load sharp, decode/resize an in-memory self-authored raster, stream numbered NDJSON probe frames at start/1 second/28 seconds, record RSS, and stop its timer on disconnect. Outbound probing targets only a configured project-owned public endpoint and reports counts/timing, not body data. Disable the route when the flag is false.
- [ ] Run `pnpm test tests/unit/limits.test.ts`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Expected: all pass. Deploy the tiny app to the eligible selected host. Set `DEPLOYMENT_URL` in the execution environment to the actual URL returned by deployment, then run `pnpm probe:host -- --url $env:DEPLOYMENT_URL` with its probe token in the environment.
- [ ] Observe the first streamed frame before completion, survival beyond 27 seconds, cancellation, native decode/hash operation, and the actual host's function/memory settings. Exercise 3 simultaneous probe requests with self-authored maximum-size 20-megapixel inputs and no more than 2 simultaneous decodes per request, then bounded fetches with 6 overall/2 per-origin limits. Record observed peak RSS and leave at least 25% memory headroom; lower decode concurrency if needed. Repeat the actual network-pinning portion after Task 2. If capability/eligibility fails, select a compatible Node host within the authorized budget immediately; do not spend a day adding a second backend.
- [ ] Commit the tested shell and measured capability note, excluding credentials and response payloads:

```sh
git add package.json pnpm-lock.yaml tsconfig.json next-env.d.ts next.config.ts eslint.config.mjs vitest.config.ts .gitignore .env.example src/app src/lib src/server/config.ts src/server/limits.ts scripts/probe-host.ts tests/unit/limits.test.ts docs/validation/hosting.md
git commit -m "feat: establish hosted Node streaming and image-processing slice"
```

### Task 2: Fetch original publisher evidence and images safely

**Milestone/timebox:** M1, next 2–3 hours. Fetching and policy checks are prerequisites to a real verified card.

**Files:** Create the four `fetch/` and `sources/` modules in the map, `tests/unit/source-policy.test.ts`, `tests/integration/safe-fetch.test.ts`, `tests/support/fixtures.ts`; modify package/lock and hosting note.

**Interfaces:** Produce `safeFetch(url: string, kind: "html" | "image" | "robots", ctx: RunContext): Promise<FetchResult>`; `FetchResult = { finalUrl: string; contentType: string; bytes: Uint8Array; retrievedAt: string; status: number }`; `checkAccess(url: string, ctx: RunContext): Promise<{ allowed: boolean; retryAt?: number; reason?: FailureCode }>`; `extractCandidates(page: FetchResult, university: University, inherited: UsagePolicy): Candidate[]`; `mergePolicy(a: UsagePolicy, b: UsagePolicy): UsagePolicy`; `bindEvidence(html: string, imageUrl: string): { excerpt: string; association: Evidence["association"] }`.

- [ ] Install pinned `undici`, `cheerio`, `ipaddr.js`, `robots-parser` and necessary types. Author a fictitious university HTML fixture, an explicit photo caption, a partner-campus visit article, a logo/footer and restrictive robots text. Mark these as synthetic test material, never live demo data.
- [ ] RED: write narrow tests for caption association and the absence of a storage exception after a publisher fetch.

```ts
it("does not treat a university footer as photo attribution", () => {
  const result = bindEvidence('<img src="/x.jpg"><footer>Example University</footer>',
    "https://example.edu/x.jpg");
  expect(result.association).toBe("none");
});
it("preserves discovery restrictions after following the source", () => {
  const common = { origin: "test", policyVersion: "v1", basis: [],
    display: "link_only" as const };
  expect(mergePolicy({ ...common, retention: "transient_only" },
    { ...common, retention: "cache_permitted" }).retention).toBe("transient_only");
});
```

- [ ] Run `pnpm test tests/unit/source-policy.test.ts`; observe failures for the incorrect association/retention behavior before implementing it.
- [ ] GREEN: parse HTML as data with Cheerio. Bind `figure/figcaption`, same gallery item or explicit image metadata to that exact image; retain article context for contradictions, but never award image attribution from a footer. Resolve relative `src`, `srcset` and common lazy-load attributes against the final publisher URL. Use this policy ordering, with display permission computed independently from documented applicable permissions:

```ts
export function mergePolicy(a: UsagePolicy, b: UsagePolicy): UsagePolicy {
  const rank = { cache_permitted: 0, transient_only: 1, disallowed: 2 };
  const retention = rank[a.retention] >= rank[b.retention] ? a.retention : b.retention;
  const display = a.display === "disallowed" || b.display === "disallowed"
    ? "disallowed" : a.display === "direct_permitted" && b.display === "direct_permitted"
    ? "direct_permitted" : "link_only";
  const expiry = [a.expiresAt, b.expiresAt].filter((x): x is string => Boolean(x)).sort()[0];
  return { retention, display, origin: `${a.origin}+${b.origin}`,
    policyVersion: "v1", basis: [...a.basis, ...b.basis], expiresAt: expiry,
    attributionText: [a.attributionText, b.attributionText].filter(Boolean).join("; ") || undefined };
}
```

- [ ] RED: exercise `safeFetch` through injected DNS/socket transport in `safe-fetch.test.ts`. Table cases: loopback; RFC1918; link-local/cloud metadata; IPv6 loopback/ULA; IPv4-mapped IPv6 private address; mixed public/private DNS; redirect to private address; rebinding from public to private; credentials in URL; unsupported port/scheme; fourth redirect; oversized decompressed HTML; endless body; abort. Assert rejection and absence of a connection to the unsafe destination. A deterministic local transport fixture is permitted only in tests; production cannot turn off destination checks.
- [ ] Run `pnpm test tests/integration/safe-fetch.test.ts`; each case must fail for the missing guard, not a real DNS/network outage.
- [ ] GREEN: validate HTTP(S), no URL credentials and ports 80/443; resolve all DNS answers and reject any non-public address using parsed address ranges. Pin the chosen validated IP through undici's connector/lookup while retaining original Host and TLS server name and certificate validation. Disable automatic redirects; validate each new destination with a maximum of 3 redirects. Never resolve again through an unvalidated default connection. Limit decoded response bytes while reading, not just Content-Length. Use `AbortSignal.any` with caller cancellation and the smaller of 3 seconds/remaining request time; close body and dispatcher on exit. All outbound requests consume the shared semaphore and host semaphore.
- [ ] Apply `checkAccess` before publisher pages and image origins. Fetch bounded robots using the same safe transport without recursive robots checks; 404 means no robots file, while 401/403/429, ambiguous fetch failures or a disallow rule cause skip. Honor publisher terms, explicit prohibitions, Retry-After and crawl delay; skip if pacing cannot fit the deadline. UA is `VisualUniversityProfile/0.1 (+<configured real project/contact URL>)`; no configured real URL means publisher crawling is disabled. A public URL or a citation alone is not a display license. Unknown display basis yields a source link only; preserve author/license obligations when granted.
- [ ] Run both test files, then repeat the deployed native/network check. Expected: unsafe targets never connect; allowed original pages can be inspected within limits; policies survive derivation. Commit only the scoped files:

```sh
git add package.json pnpm-lock.yaml src/server/fetch src/server/sources tests/unit/source-policy.test.ts tests/integration/safe-fetch.test.ts tests/support/fixtures.ts docs/validation/hosting.md
git commit -m "feat: collect publisher evidence through bounded policy-aware fetching"
```

### Task 3: Resolve an institution through real APIs with shared cost protection

**Milestone/timebox:** M1, next 2 hours. Start with fully specified names; uncertainty is already supported, richer choice handling follows in Task 6.

**Files:** Create `usage/ledger.ts`, `usage/ledger.lua`, `discovery/brave.ts`, `discovery/wikidata.ts`, `discovery/resolver.ts`, `discovery/planner.ts`; `tests/unit/resolver.test.ts`, `tests/integration/discovery.test.ts`, `tests/integration/ledger.test.ts`. Modify configuration/package/lock.

**Interfaces:** Produce `normalizeQuery(query: string): string`; `resolveUniversity(query: ProfileQuery, ctx: RunContext): Promise<Resolution>`; `discover(university: University, gaps: Category[], ctx: RunContext): Promise<Candidate[]>`; `searchBrave(input: { query: string; kind: "web" | "images" }, ctx: RunContext): Promise<Array<{ pageUrl: string; imageUrl?: string; policy: UsagePolicy }>>`; `lookupWikidata(query: string, ctx: RunContext): Promise<Array<{ entityId: string; name: string; aliases: string[]; website?: string; city?: string; country?: string }>>`. Produce `Ledger.admit(ctx: RunContext): Promise<{ allowed: boolean; retryAfterSeconds: number }>`; `Ledger.reserve(ctx: RunContext, kind: "brave" | "ai", units: number): Promise<string>`; `Ledger.settle(reservationId: string, actualUnits: number | null): Promise<void>`; `Ledger.release(requestId: string): Promise<void>`. `units` is calls for Brave and integer micro-USD for AI. A constructor `createLedger(evalScript: EvalScript): Ledger` takes `type EvalScript = (script: string, keys: string[], args: string[]) => Promise<unknown>` so production Upstash and test Redis run the identical Lua without replacing its logic.

- [ ] Install pinned `@upstash/redis` and the `redis` client as a development-only dependency for local/CI Lua tests. Use a local Redis test service when available; otherwise use an isolated namespace on the authorized free store for the initial task, then CI uses its own local service. Configure current credit allowance and separate development/judging pools from the actual account; if 1,000 Brave calls are available, development can use at most 800 and reserve 200 for judging. No automatic paid overage. Record no keys in Git.
- [ ] RED: normalize full names without hardcoding example aliases; require strict SafeSearch in both serialized Brave endpoint requests. Use an HTTP-boundary stub returning authored schema-correct responses; verify the request actually emitted by the adapter, not a mocked adapter result.

```ts
it("normalizes spacing and Unicode without inventing an alias expansion", () => {
  expect(normalizeQuery("  Astana   IT University  ")).toBe("astana it university");
  expect(normalizeQuery("NU")).toBe("nu");
});
```

- [ ] Run `pnpm test tests/unit/resolver.test.ts tests/integration/discovery.test.ts`; expect normalization and missing `safesearch=strict` failures.
- [ ] GREEN: implement conservative normalization and actual Brave/Wikidata endpoints with keys in headers. Brave calls explicitly set `safesearch=strict`, disable unbounded retries, validate payload shape and count attempts before dispatch. Use only documented locale parameters; put Kazakh/Russian terms in the query when needed. Return restricted discovery records only in memory, never search snippets as verified evidence.

```ts
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}
const parameters = new URLSearchParams({ q: input.query, safesearch: "strict" });
const endpoint = input.kind === "images"
  ? "https://api.search.brave.com/res/v1/images/search"
  : "https://api.search.brave.com/res/v1/web/search";
```

- [ ] Resolve Wikidata candidates using bounded `wbsearchentities` and `wbgetentities` requests (maximum 2 requests initially). Cross-check official page name/contact/city against the independent identity signal. Fall back to Brave for missing candidates or conflicting fields. A top result, `.edu` suffix or logo is insufficient. Retain supported identity evidence and campus/city. Return `needs_selection` for credible competing identities and `unavailable` for failed dependencies; never invent a domain.

The optional AI text resolver is unnecessary for this MVP: deterministic resolution uses no such call. If introduced in secondary work, its existing two-second/cost allowance remains binding; it cannot invent an official domain.
- [ ] Discover a first image by official homepage/high-value navigation, then official-domain `site:` queries if necessary. Broader image search is allowed only after an official attempt produces a gap. Fetch every promising original publisher page through Task 2 and bind the image evidence. A single allowed photo is enough for M1; no forced quota and no manual university map.
- [ ] RED: use the same ledger command semantics in an isolated Redis test namespace; verify four concurrent `admit` calls allow only three, duplicate reservation IDs cannot double-charge, a reservation exceeding the AI allowance fails atomically, and `settle(id, null)` retains the reservation. Test the store-down path produces zero new paid dispatches. CI later uses a local Redis service, not production credentials.
- [ ] Run `pnpm test tests/integration/ledger.test.ts` against the isolated store; observe cap/race failures before implementing the Lua transaction.
- [ ] GREEN: one Redis Lua command per atomic operation manages active leases, rolling IP guard, session bucket and cost reservations. Use Redis server time, integer money, request/reservation IDs and a 45-second admission lease; remove expired active leases atomically. Apply the shared limit before spending; renew only while the request is active, and recheck lease before new provider calls. Keep spending reservations until reconciliation; lease expiry must not refund uncertain charges. The reservation branch has this exact atomic shape:

```lua
-- KEYS: reservation key, aggregate-used key, request-used key
-- ARGV: units, aggregate ceiling, request ceiling
if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
local amount = tonumber(ARGV[1])
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
local request = tonumber(redis.call('GET', KEYS[3]) or '0')
if total + amount > tonumber(ARGV[2]) then return 0 end
if request + amount > tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[1], amount)
redis.call('INCRBY', KEYS[2], amount)
redis.call('INCRBY', KEYS[3], amount)
return 1
```

- [ ] Implement settlement idempotently as the difference between reserved and known actual cost; unknown billing retains the full amount. Admission enforces the exact global/session/IP values above and returns the earliest retry interval. Trust platform forwarding only for the configured proxy; HMAC IPs and never store raw IPs in application telemetry. Exclude source/query data from the ledger. App/provider gross usage, credit use, paid use and funded balance remain separate values.
- [ ] Run the three focused suites. With live credentials supplied through the environment, make one bounded resolution/discovery request and confirm its original source in memory. A paid ledger reservation is required even for this smoke call. Commit:

```sh
git add package.json pnpm-lock.yaml src/server/config.ts src/server/usage src/server/discovery tests/unit/resolver.test.ts tests/integration/discovery.test.ts tests/integration/ledger.test.ts
git commit -m "feat: resolve universities with real discovery and atomic cost limits"
```

### Task 4: Turn one real candidate into a conservative verified decision

**Milestone/timebox:** M1, next 2 hours.

**Files:** Create `images/prepare.ts`, `ai/adapter.ts`, `ai/openai.ts`, `ai/assessment-schema.ts`, `policy/decide.ts`; `tests/unit/decision.test.ts`, `tests/integration/image-input.test.ts`, `tests/integration/ai-adapter.test.ts`; modify config/package/lock.

**Interfaces:** Consume `safeFetch`, `Ledger.reserve/settle` and contracts. Produce `prepareImage(candidate: Candidate, ctx: RunContext): Promise<PreparedCandidate>`; `createOpenAiAdapter(config: { model: string; apiKey: string }): AiAdapter`; `decide(input: { resolved: boolean; usable: boolean; evidence: Evidence; assessment: Assessment }): Decision`. The adapter is the only module importing the OpenAI SDK. `describe` may return a normalized unavailable error until Task 8 adds its first consumer; no fake text result.

- [ ] RED: use self-authored raster bytes to test invalid media, mismatched MIME, oversized dimensions, SVG/active formats, malformed decode and derivative/request limits. Assert malformed or URL-shaped inputs never reach the HTTP provider boundary. Create source decision fixtures with literal expected scores:

```ts
it.each([
  ["official", "mention", 0, 5, 40, "withheld"],
  ["official", "explicit", 0, 10, 80, "verified"],
  ["attributable", "explicit", 0, 10, 70, "uncertain"],
  ["attributable", "explicit", 20, 10, 90, "verified"],
] as const)("scores %s/%s from evidence", (authority, association, corroboration,
  visual, score, status) => {
  const input = decisionFixture({ authority, association, corroboration, visual });
  expect(decide(input)).toMatchObject({ score, status });
});
```

`decisionFixture` is a test-only factory in `tests/support/fixtures.ts`, signature `decisionFixture(patch: { authority: Evidence["authority"]; association: Evidence["association"]; corroboration: 20 | 10 | 0; visual: 10 | 5 | 0 }): Parameters<typeof decide>[0]`. Its authored identity is resolved, media usable, display permitted, safety clear and location/category supported; `officialDirect` requires official+explicit, `independentEquivalent` requires explicit+20. It assigns distinct literal source IDs to corroboration and attribution. A fixture never supplies production demo images.

- [ ] Run the decision/media tests and require the expected gate/score failures. Add individual negative tests for visiting another campus, fake evidence ID, the same caption counted twice, display not permitted, unresolved safety, stock/render, and a model certainty field attempting to override policy.
- [ ] GREEN: safe-fetch image bytes, require JPEG/PNG/WebP magic and MIME compatibility, decode with sharp `limitInputPixels: 20_000_000`, reject animated/multipage/active formats and tiny assets (short edge below 160 or total pixels below 60,000). Strip metadata and re-encode to JPEG with long edge ≤1,024; lower JPEG quality through a bounded 80/65/50 sequence if needed, then skip if still >512 KiB. Compute original SHA-256 before transformation and derivative SHA-256 afterward. Keep buffers only in request memory.
- [ ] Add the OpenAI SDK with exact lockfile version. Build Responses inputs from validated bytes only; include bounded original-publisher excerpts, image IDs and allowed source IDs as untrusted data. Use structured output with categories/enums, no tools/browsing, `store: false`, SDK retries disabled, ≤10-second timeout and the request AbortSignal. Account for base64 expansion before dispatch:

```ts
const imageParts = input.images.map(image => ({
  type: "input_image" as const, detail: "low" as const,
  image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`,
}));
const client = new OpenAI({ apiKey: config.apiKey, maxRetries: 0 });
```

The SDK payload builder also inserts a text image ID before each image part so outputs cannot be attached by array position. Validate all returned IDs against the input set and reject duplicates, unknown IDs, invalid category values and injected URLs. `Assessment` accepts no final numeric confidence from AI. Reserve worst-case model input/image/output cost first, use bounded output tokens, and settle from actual usage. Verify the configured Luna model's current image-token accounting and availability in one low-cost call; do not silently choose another model if access fails.
- [ ] Implement deterministic decision policy in the following order: confirmed conflict/unsafe/stock/render/irrelevant/forbidden → rejected; unresolved safety/relevance or unassessed image → withheld; compute points; apply provenance/identity/media/display/location/category gates; cap at 79 if a verified gate is missing; then label. Unsafe content never appears in the uncertain gallery. Core arithmetic:

```ts
const components = {
  authority: { official: 25, attributable: 15, unknown: 0 }[evidence.authority],
  attribution: { explicit: 45, gallery: 25, mention: 10, none: 0 }[evidence.association],
  corroboration: evidence.corroboration,
  visual: assessment.visual,
};
const raw = Object.values(components).reduce((sum, value) => sum + value, 0);
const score = allVerifiedGates ? raw : Math.min(raw, 79);
const status = score >= 80 ? "verified" : score >= 60 ? "uncertain" : "withheld";
```

Here `evidence`/`assessment` are the `decide` input and `allVerifiedGates` is the conjunction of the seven spec gates, including direct official or equivalent independent provenance. Corroboration requires distinct supporting evidence and independent publisher relationships; otherwise award 0. City membership supports only city category. Return explanatory reasons and each component, not a probability.
- [ ] Run all three focused suites, then one bounded live candidate through the real adapter. Expected: a qualifying original-source image receives a category and a deterministic verified decision; weak candidates remain withheld/uncertain. Commit:

```sh
git add package.json pnpm-lock.yaml src/server/config.ts src/server/images/prepare.ts src/server/ai src/server/policy tests/unit/decision.test.ts tests/integration/image-input.test.ts tests/integration/ai-adapter.test.ts tests/support/fixtures.ts
git commit -m "feat: verify source-bound images through a byte-only AI adapter"
```

### Task 5: Connect the API stream to a visible browser result and deploy M1

**Milestone/timebox:** M1, remaining time up to hour 12. This completes the first milestone; it is not optional polish.

**Files:** Create `profile/run-profile.ts`, `profile/services.ts`, `profile/assemble.ts`, the two API routes, three components, `lib/events.ts`, `lib/event-schema.ts`, `lib/read-events.ts`; modify page/styles; create `tests/unit/read-events.test.ts`, `tests/integration/profile-route.test.ts`, `tests/e2e/vertical-slice.spec.ts`, `playwright.config.ts`.

**Interfaces:** Produce `runProfile(query: ProfileQuery, ctx: RunContext, emit: Emit): Promise<void>`; `assembleProfile(input: { university: University; cards: ImageCardData[]; description: Claim[]; sources: SourceRef[]; warnings: FailureCode[]; elapsedMs: number }): Profile`; `readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: ProfileEvent) => void, signal: AbortSignal): Promise<void>`; `POST(request: Request): Promise<Response>` in each route; `ImageCard({ card, onDeliveryFailure }: { card: ImageCardData; onDeliveryFailure: (id: string) => void }): React.JSX.Element`; `ProfileView({ profile }: { profile: Profile }): React.JSX.Element`; `SearchForm(): React.JSX.Element`. `services.ts` wires the earlier concrete functions, ledger and configured adapter; no hidden fixture provider.

- [ ] RED: test a streamed record split mid-UTF-8 character and mid-JSON, then a terminal record. Also reject an EOF without final/fatal, a gap in sequence, conflicting request IDs and post-terminal frames. A test-only `byteStream(chunks: string[]): ReadableStream<Uint8Array>` enqueues encoded authored strings; use byte slices for the UTF-8 split case.

```ts
it("does not accept a truncated stream as completion", async () => {
  const frame = JSON.stringify({ v: 1,
    requestId: "e3811aae-9ec9-4bbb-a32f-b62af38f4337", seq: 1,
    type: "stage", data: { stage: "resolving" } }) + "\n";
  await expect(readEvents(byteStream([frame]), () => {},
    new AbortController().signal)).rejects.toThrow("protocol_error");
});
```

- [ ] Run `pnpm test tests/unit/read-events.test.ts`; expect the missing-terminal assertion to fail. Implement the strict envelope schema and parser using the transport contract above. Decoder nucleus:

```ts
const decoder = new TextDecoder("utf-8", { fatal: true });
let pending = "";
pending += decoder.decode(chunk, { stream: true });
const lines = pending.split("\n");
pending = lines.pop() ?? "";
for (const line of lines) {
  const event = profileEventSchema.parse(JSON.parse(line));
  consume(event);
}
```

`chunk` is each reader result; `profileEventSchema` is the strict Zod schema in `event-schema.ts`; `consume(event: ProfileEvent): void` is the parser's internal function enforcing request/sequence/terminal rules before invoking `onEvent`. Check byte limits before concatenation, not after unbounded buffering. Implement reader cleanup and abort in `finally`.
- [ ] RED: exercise the real route/coordinator with external HTTP-boundary fixtures: query to source to prepared bytes to provider assessment to source-linked card. Assert exactly one terminal event, no raw search fields/bytes, no-store headers and no provider calls for invalid/admission-rejected input. Include a fixture with official explicit attribution yielding exactly 80, then change its location and require rejection.
- [ ] Run `pnpm test tests/integration/profile-route.test.ts`; expect no verified card until wiring is added. Implement `runProfile`: acquire admission, emit resolving, resolve, emit identity or clarification, attempt official discovery, safe-prepare one candidate, assess, decide, emit admitted card, assemble final, release lease in `finally`. Every stage uses the same deadline and request counters from the start. M1 can return `partial` with one photo and no campus description; it cannot claim complete.
- [ ] Add server session issuance with cryptographically random IDs and HMAC signatures. Query selection remains server-validated. Capture request receipt time before parsing/admission so those steps consume the same 27-second deadline. Limit route body before parsing, validate origin, and derive trusted IP context server-side. Encode event JSON with a single writer that owns request ID, `seq`, terminal guard and the stream controller. Connect request/stream cancellation to the coordinator AbortController. Node route configuration matches the tested host.
- [ ] RED: Playwright enters an authored university query against a fixture-backed external transport in test-only runtime and expects a visible verified photo, original publisher link and score. A separate opt-in live smoke has no response substitution. Add the plain form, factual stages, cancellation/retry and one card. Direct-image nucleus:

```tsx
return card.delivery === "remote" && card.displayUrl ? (
  <figure>
    <img src={card.displayUrl} alt={`${card.category} at the selected university`}
      referrerPolicy="no-referrer" onError={() => onDeliveryFailure(card.id)} />
    <figcaption><a href={card.source.url} target="_blank" rel="noopener noreferrer">
      Publisher source</a> · {card.score}/100 — {card.status}
      {card.source.policy.attributionText && <span> · {card.source.policy.attributionText}</span>}
    </figcaption>
  </figure>
) : <p><a href={card.source.url}>Publisher source</a> — Image unavailable</p>;
```

Use an explicit documented ESLint exception for unoptimized remote `<img>` in this component; do not globally disable image rules. Never use `next/image` or a local proxy for these URLs. Expose only permitted screened URLs. Clear transient state on a new search/unmount and use no persistent browser storage.
- [ ] Run focused tests, `pnpm exec playwright test tests/e2e/vertical-slice.spec.ts`, lint, typecheck and build. Deploy. Enter a fully specified university name that has not been put into production code; observe live source evidence, an actual visible verified/classified photo, score, source link and final state. Test another institution rather than patching a whitelist. Record latency/call counts and pass/fail without retaining restricted image/search payloads.
- [ ] If actual image display is unavailable or evidence stays below verified, keep the honest missing state and fix the general discovery/permission integration; M1 remains incomplete. Commit once the real gate passes:

```sh
git add src/app src/components src/lib src/server/profile tests/unit/read-events.test.ts tests/integration/profile-route.test.ts tests/e2e/vertical-slice.spec.ts playwright.config.ts package.json pnpm-lock.yaml docs/validation/hosting.md
git commit -m "feat: stream a real verified university image into the browser"
```

### Task 6: Generalize ambiguity and official-first retrieval across categories

**Milestone/timebox:** M2, hours 12–18. Preserve the working vertical slice while expanding useful coverage.

**Files:** Modify `discovery/resolver.ts`, `discovery/planner.ts`, `sources/publisher.ts`, `components/SearchForm.tsx`, `profile/run-profile.ts`, `src/app/api/profile/route.ts`; create `src/server/discovery/selection.ts`, `tests/unit/discovery-planner.test.ts`, `tests/integration/selection.test.ts`; extend resolver/discovery tests and test fixtures.

**Interfaces:** Keep `resolveUniversity` and `discover` unchanged. Produce `planQueries(input: { university: University; gaps: Category[]; officialAttempted: boolean; language: "en" | "ru" | "kk" }): Array<{ query: string; scope: "official" | "fallback"; category: Category }>`; `issueSelectionToken(university: University, ctx: RunContext): string`; `readSelectionToken(token: string, ctx: RunContext): University`. Tokens contain authenticated encrypted, expiring server-verified identity data for the current session; they are not a persistent search-result cache.

- [ ] RED: ensure fallback never runs just because a timer expires. Use an authored `universityFixture()` returning the University structure above with name `Example University`, campus `Main`, city `Example City`, country `KZ`, domain `example.edu` and one synthetic source. Keep test-only fields outside production.

```ts
it("keeps queries official until an official attempt has occurred", () => {
  const jobs = planQueries({ university: universityFixture(), gaps: ["library"],
    officialAttempted: false, language: "en" });
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.every(job => job.scope === "official")).toBe(true);
  expect(jobs[0].query).toContain("site:example.edu");
});
```

- [ ] Run `pnpm test tests/unit/discovery-planner.test.ts tests/unit/resolver.test.ts`; require the planned official-first and alias ambiguity failures. Add literal fixtures for competing NU institutions, multiple campuses, country preference with a real international result, misspelled input and both identity providers failing.
- [ ] GREEN: produce one best-language query per category gap, not all languages times all categories. Deterministically use these initial vocabulary entries, expanding only when live evidence justifies it:

```ts
const vocabulary = {
  en: { campus: "campus", dormitory: "dormitory residence", classrooms: "classrooms",
    library: "library", laboratories: "laboratory", sport: "sports facilities",
    student_life: "student life", city: "city" },
  ru: { campus: "кампус", dormitory: "общежитие", classrooms: "аудитории",
    library: "библиотека", laboratories: "лаборатории", sport: "спорт",
    student_life: "студенческая жизнь", city: "город" },
  kk: { campus: "кампус", dormitory: "жатақхана", classrooms: "дәрісхана",
    library: "кітапхана", laboratories: "зертхана", sport: "спорт",
    student_life: "студенттік өмір", city: "қала" },
} satisfies Record<"en" | "ru" | "kk", Record<Category, string>>;
```

Escape user terms as data in queries; official restriction uses confirmed domains only. Choose source language from supported identity/page language and fallback evidence. Country hint is visible and changeable in the UI. City photos require the selected city and cannot satisfy facility coverage. Reserve 2 of the 8 content pages for attributable fallback, and distribute shortlist slots over category gaps. Official authority affects ordering, never acceptance of an unrelated image.
- [ ] Add shallow navigation ranking for facilities/accommodation/library/labs/sport/student galleries; ignore authentication, JS-only tours and PDFs. Stop after the shared limits; no breadth-first general crawl. Parse typed dates from explicit publisher/image metadata, recording their basis. Omit ambiguous dates; retrieval time is always the real fetch time. Never promote Brave crawl time, an upload path year or a footer year into publication/capture time.
- [ ] RED: `readSelectionToken` rejects changed ciphertext, expired tokens, another session's token and a modified campus/domain. A signed or encrypted token is not permission to accept an arbitrary client URL. Confirm an ambiguous request ends `needs_selection` without image processing and a chosen campus starts a new measured generation request.
- [ ] Run `pnpm test tests/integration/selection.test.ts`; observe the validation failures. GREEN: use AES-256-GCM with a separate derived key from `SESSION_SECRET`, random 12-byte nonce and authenticated session ID; include issued/expiry times (5 minutes), identity evidence and selected campus. Limit token input to 8 KiB and total request body to a separate **12 KiB only when a selection token is present**; ordinary query requests remain 2 KiB. Validate decoded schema and revalidate official identity evidence when expired/changed. Retain no token in local storage or server logs. This explicit selected-request bound replaces the ordinary-body limit only for this path.
- [ ] Update search UI to show credible name/campus/city/domain choices with publisher links. On selection submit the authenticated token; show initial resolution time and subsequent generation time separately and retain total user interaction time. Do not silently treat `NU` as Nazarbayev globally.
- [ ] Run resolver/planner/selection/discovery tests and the existing vertical-slice test; deploy only after the existing path still passes. Commit:

```sh
git add src/server/discovery src/server/sources/publisher.ts src/server/profile/run-profile.ts src/components/SearchForm.tsx src/app/api/profile/route.ts tests/unit/resolver.test.ts tests/unit/discovery-planner.test.ts tests/integration/selection.test.ts tests/integration/discovery.test.ts tests/support/fixtures.ts
git commit -m "feat: support evidenced campus choices and multilingual category discovery"
```

### Task 7: Remove exact and ordinary visually similar duplicates before AI

**Milestone/timebox:** M2, hours 18–22. Advanced crop matching is explicitly secondary.

**Files:** Create `images/deduplicate.ts`, `tests/unit/deduplicate.test.ts`; modify `images/prepare.ts`, `profile/run-profile.ts`, `tests/support/fixtures.ts`, package/lock.

**Interfaces:** Produce `differenceHash64(gray9x8: Uint8Array): string`; `hammingDistance(a: string, b: string): number`; `deduplicate(candidates: PreparedCandidate[]): Promise<PreparedCandidate[]>`. Use a 64-bit difference hash as the simple perceptual hash, plus SSIM confirmation; do not label it a DCT pHash. No public contract depends on the hash algorithm name.

- [ ] Add pinned `ssim.js` for the numerical comparison only, checking its maintained status/license and isolating its import inside `deduplicate.ts`. Its archived upstream is a bounded dependency risk: compare known test pairs, pin its exact version, and do not give it remote URLs or parsing responsibilities. sharp remains the sole decoder.
- [ ] RED: author one 640×480 raster of a simple building in test utilities; derive an identical copy, JPEG recompression and half-size version with sharp. Use a distinct authored second building and a changed viewpoint fixture that must remain. `dedupFixtures()` returns `{ original, identical, resized, recompressed, distinct, betterEvidenceCopy }` as PreparedCandidate objects with distinct IDs and literal evidence ranks. It does not use AI-generated/live campus pictures.

```ts
it("keeps one representative for a resized copy before paid analysis", async () => {
  const f = await dedupFixtures();
  const kept = await deduplicate([f.original, f.resized, f.distinct]);
  expect(kept.map(item => item.candidate.id)).toEqual(["original", "distinct"]);
});
it("prefers the supported representative over a weaker duplicate", async () => {
  const f = await dedupFixtures();
  const kept = await deduplicate([f.original, f.betterEvidenceCopy]);
  expect(kept.map(item => item.candidate.id)).toEqual(["better-evidence"]);
});
```

- [ ] Run `pnpm test tests/unit/deduplicate.test.ts`; expect duplicate counts/representative selection to fail. Add equal hash but dissimilar-image, different aspect ratio and signed-URL tests; do not strip resource-changing query parameters.
- [ ] GREEN: exact source-byte hash first, then normal perceptual proposals. A 9×8 grayscale thumbnail supplies 64 horizontal comparisons:

```ts
export function differenceHash64(gray9x8: Uint8Array): string {
  if (gray9x8.length !== 72) throw new Error("invalid_media");
  let value = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    value = (value << 1n) | BigInt(gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1]);
  }
  return value.toString(16).padStart(16, "0");
}
export function hammingDistance(a: string, b: string): number {
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
}
```

- [ ] Only when Hamming ≤6 and aspect-ratio difference ≤5%, normalize both to the same dimensions with long edge 128 and compare grayscale SSIM. Expand grayscale to the pixel format required by the pinned SSIM API; alpha is opaque, not uninitialized. Merge only if SSIM ≥0.95. Compare a proposed member to the selected representative rather than allowing transitive weak matches to collapse distinct views. Keep the strongest explicit evidence/official provenance, then usable resolution. Preserve permitted independent references without treating same-image reposts as independent corroboration.
- [ ] Compute `perceptualHash` in preparation before ordinary comparison; the optional field was legitimately absent in the single-image M1 path. If hashing fails, exact-hash dedup still works, but do not invent a zero hash or merge an unassessed perceptual pair. Insert dedup before the AI shortlist, cap decoded image concurrency at 2, and free source buffers after hashing/derivative extraction. Do not decode all 24 maximum-size images together. Exact/resize/recompression tests are required now; aggressive/off-center crop coverage is not claimed.
- [ ] Run dedup tests and the vertical-slice integration test. Expected: repeated/ordinary similar photos consume one vision slot; distinct images remain; no known exact duplicates survive. Commit:

```sh
git add package.json pnpm-lock.yaml src/server/images src/server/profile/run-profile.ts tests/unit/deduplicate.test.ts tests/support/fixtures.ts
git commit -m "feat: deduplicate source images before multimodal analysis"
```

### Task 8: Complete the case-facing gallery, dates and cited campus description

**Milestone/timebox:** M2, hours 22–30. Deploy the full end-to-end case path at this gate.

**Files:** Create `profile/description.ts`, `tests/unit/profile-assembly.test.ts`, `tests/unit/description.test.ts`, `tests/e2e/profile-gallery.spec.ts`; modify `ai/openai.ts`, `profile/assemble.ts`, `profile/run-profile.ts`, all three components, styles and test fixtures.

**Interfaces:** Produce `supportedDescription(proposed: Claim[], facts: Claim[], sources: SourceRef[]): Claim[]`; `deriveVisibleProfile(profile: Profile, failedIds: ReadonlySet<string>): Profile`. Consume the existing `AiAdapter.describe`, `assembleProfile`, `ImageCardData` and event contracts. No incompatible shape changes.

- [ ] RED: completeness requires all five base categories, a supported campus claim and visible images; uncertain cards never count. `profileFixture()` is a test-only complete Profile with five authored verified cards and one cited campus claim. Its library image ID is `library-1`.

```ts
it("downgrades coverage when a remote facility image fails to load", () => {
  const visible = deriveVisibleProfile(profileFixture(), new Set(["library-1"]));
  expect(visible.state).toBe("partial");
  expect(visible.verifiedBaseCategories).toBe(4);
  expect(visible.cards.find(card => card.id === "library-1")?.delivery).toBe("missing");
});
it("does not retain a description claim with an invented source ID", () => {
  const profile = profileFixture();
  const claims = supportedDescription([
    { text: "The campus has a library.", campusFact: true, evidenceIds: ["invented"] },
  ], profile.description, profile.sources);
  expect(claims).toEqual([]);
});
```

- [ ] Run `pnpm test tests/unit/profile-assembly.test.ts tests/unit/description.test.ts`; require expected false-completeness/unsupported-claim failures. Add city-only text, two cards sharing one image, opt-in uncertainty and missing publication-date cases.
- [ ] GREEN: compute completeness from actual admitted cards and supported text:

```ts
const base: Category[] = ["campus", "dormitory", "classrooms", "library", "city"];
const visibleVerified = cards.filter(card => card.status === "verified"
  && card.delivery === "remote" && Boolean(card.displayUrl));
const covered = new Set(visibleVerified.map(card => card.category));
const complete = base.every(category => covered.has(category))
  && description.some(claim => claim.campusFact);
const state = complete ? "complete" : visibleVerified.length > 0
  ? "partial" : "insufficient_evidence";
```

`cards` and `description` come from `assembleProfile` input. All eight sections and required filters are always rendered, so controls are part of this invariant. Additional category gaps remain explicit even for a complete five-base profile. `deriveVisibleProfile` removes failed cards from visible coverage and sets missing delivery; server attribution score stays unchanged and no completeness badge survives missing required display.
- [ ] Extract a maximum of 6 concise factual campus statements from explicit publisher text, with source IDs and evidence spans. Initially favor extractive sentences to make support checking reliable. Ask `AiAdapter.describe` to select 2–4 supplied fact sentences, returning exact supplied text/IDs rather than inventing paraphrases. `supportedDescription` permits only fact text present in the supplied set with valid matching citations. The model may order/select; the server decides inclusion. On timeout/invalid output, use up to 4 eligible factual sentences deterministically; if no campus fact exists, omit description and keep partial. This satisfies source-backed text without another fact-verification model call.
- [ ] Implement description timeout ≤4 seconds and reserve its token cost before launching; do not let optional prose displace already verified images. Keep every claim's clickable source, and never use city-only text to claim campus completeness. Bound publisher text sent to each AI request and reject source instructions.
- [ ] Add all category tabs/filter controls, counts, empty-evidence reasons, institution/campus/city and official website, live/cache label, actual timings, date labels and expandable component explanations. Label score “Evidence score”, not percentage probability. Show `Verified by source`; uncertain section is opt-in with reasons; withheld/rejected content never appears. One image has one primary category and optional supported tags, without duplicate cards in the combined gallery.
- [ ] Add direct-display failure handling: source link plus `Image unavailable` or `Display not permitted`, no fallback stock picture, proxy retry or download. `onError` updates failed IDs and calls `deriveVisibleProfile`. Dates render only their actual types; missing publication date shows retrieval date only. Old documented photos receive a freshness note separate from identity confidence.
- [ ] Run both unit suites and `pnpm exec playwright test tests/e2e/profile-gallery.spec.ts`. Check keyboard operation, mobile-width layout, cancelling, another search immediately afterward, all filters with empty states and an actual blocked remote-image response. Then run lint/typecheck/build and deploy. Repeat a live known and an unfamiliar university; show and document partial results honestly if source coverage is incomplete.
- [ ] M2 exit requires the entire pipeline and all mandatory behaviors working on the deployment. It does not require every source-poor institution to produce all categories. Commit:

```sh
git add src/server/profile src/server/ai/openai.ts src/components src/app/globals.css tests/unit/profile-assembly.test.ts tests/unit/description.test.ts tests/e2e/profile-gallery.spec.ts tests/support/fixtures.ts
git commit -m "feat: complete source-backed category profiles and honest delivery states"
```

### Task 9: Harden the 27-second pipeline, graceful failures and restricted cache boundary

**Milestone/timebox:** M3, hours 30–44. This hardens existing controls; it does not postpone initial spending/security controls until this point.

**Files:** Create `cache/policy-cache.ts`, `telemetry.ts`, `tests/unit/cache-policy.test.ts`, `tests/integration/pipeline-failures.test.ts`, `tests/integration/admission.test.ts`; modify coordinator, limits, ledger, stream route and source/AI adapters as required by failing tests.

**Interfaces:** Produce `canPersist(policies: UsagePolicy[], now: number): boolean`; `cacheGet<T>(key: string): Promise<T | null>`; `cachePut<T>(key: string, value: T, policies: UsagePolicy[], ttlSeconds: number): Promise<boolean>`; `recordMetric(input: { requestId: string; stage: string; elapsedMs: number; count?: number; costMicrousd?: number; code?: FailureCode }): void`. Cache is Redis-backed, allowlisted serialized types only, and a returned value is revalidated before use. Metrics accept no arbitrary object, text, URL or exception payload.

- [ ] RED: demonstrate that one restricted field prevents persistence of an assembled profile, expired permissions fail closed, and empty policy lists are not proof of permission.

```ts
it("does not treat an empty permission set as cache permission", () => {
  expect(canPersist([], Date.now())).toBe(false);
});
it("will not cache a profile containing a restricted source", () => {
  const p = { origin: "test", policyVersion: "v1", basis: ["fixture license"],
    expiresAt: "2026-09-17T00:00:00Z", display: "direct_permitted" as const };
  expect(canPersist([{ ...p, retention: "cache_permitted" },
    { ...p, retention: "transient_only" }], Date.parse("2026-09-16T00:00:00Z"))).toBe(false);
});
```

- [ ] Run `pnpm test tests/unit/cache-policy.test.ts`; observe unauthorized persistence failures. GREEN: implement one conservative predicate and a small cache wrapper, not a generalized caching system:

```ts
export function canPersist(policies: UsagePolicy[], now: number): boolean {
  return policies.length > 0 && policies.every(policy =>
    policy.retention === "cache_permitted" && policy.basis.length > 0
    && Boolean(policy.expiresAt) && Date.parse(policy.expiresAt!) > now);
}
```

- [ ] Apply identity≤7-day and source/profile≤24-hour TTLs, capped by earliest permission/evidence expiry. Include identity/campus and relevant query context in identity keys; use image content hash+evidence fingerprint+provider/model/prompt/schema versions for eligible assessment keys. Cache only explicitly eligible records; raw Brave/derived restricted records stay in request memory. Do not add durable negative outcomes. A cached profile labels the actual last evidence check; stale or known-broken entries cannot claim fresh verification. Support eligible-cache fallback during provider failures, but fresh cold requests remain the budget baseline. If no real source is eligible, the cache remains empty by design.
- [ ] RED: in `pipeline-failures.test.ts`, use a fake clock and controlled external transport to test 27-second finalization with accepted images; hung provider cancellation; disconnect; malformed AI output; Brave out of credits; official site denied; no images; wrong-location source; incomplete source dates; no safe display basis. Assert terminal states, actual cards and absence of new dispatch after deadline, not just mock call counts. Example terminal contract:

```ts
it("keeps accepted images and finalizes partial at the deadline", async () => {
  const result = await pipelineScenario("vision-second-batch-hangs");
  expect(result.finalState).toBe("partial");
  expect(result.verifiedImageIds).toEqual(["campus-1"]);
  expect(result.terminalCount).toBe(1);
  expect(result.dispatchAfterDeadline).toBe(false);
});
```

`pipelineScenario(name: "vision-second-batch-hangs" | "brave-down" | "ai-invalid" | "disconnect"): Promise<{ finalState: TerminalState | null; verifiedImageIds: string[]; terminalCount: number; dispatchAfterDeadline: boolean }>` is a test utility wiring the real coordinator/stream with fake external HTTP responses and a fake clock. It supplies real source/score processing and captures the observable result. On disconnect no terminal delivery is promised to the disconnected client, but no further paid work may start.
- [ ] Run `pnpm test tests/integration/pipeline-failures.test.ts`; require failures for deadline/cancellation/fallback behavior. GREEN: overlap official retrieval and early candidate processing; only start broader discovery after an official attempt; finalize shortlist in time for at most two concurrent batches. Use the 0–4/4–12/9–17/14–25/23–27-second stage budgets as scheduling targets, not fake progress or fixed sleeps. Stop starting primary vision if its timeout cannot fit; reserve assembly time. Do not wait for a hung losing promise after abort; ensure buffers/sockets/semaphores are released. SDK retries are off; any explicit retry shares attempt/time/cost limits.
- [ ] Use failure mapping exactly: completed no identity → `not_found`; competing identities → `needs_selection`; known identity/no accepted photos → `insufficient_evidence`; accepted incomplete profile → `partial`; no usable work due to dependencies/budget → `unavailable`; full five-base coverage+campus text → `complete`. A provider outage cannot become “university does not exist.” An AI outage never verifies a new photo merely from its official URL; use eligible past assessment or remain conservative.
- [ ] RED: admission tests submit 10 successive searches with each prior generation released, then several independent sessions on one IP; assert they are allowed under the stated refill policy. Test 4 simultaneous global pipelines, 2 same-session pipelines, 121 IP submissions within a rolling minute, session rotation while aggregate budget is exhausted, a Redis outage and timed-out billing. Use a test Redis namespace and controllable clock with actual atomic operations.
- [ ] Run `pnpm test tests/integration/admission.test.ts tests/integration/ledger.test.ts`; fix only behavior that fails. Verify retry intervals, global3/session1 limits and no judge-specific bypass. Add host-specific trusted-IP parsing tests. Keep session/IP guards separate from spending authorization.
- [ ] Inspect emitted API/browser storage/log/Redis data with authored restricted fixtures. No image bytes, search snippets/URLs or model payloads may persist. Disable Next fetch/data caching for restricted processing, response caching, analytics payload capture and persistent browser storage. Direct remote browser cache behavior is governed by publisher headers; if incompatible with policy, do not display. `recordMetric` serializes only the stated fields and normalized codes.
- [ ] Run the focused suites plus existing pipeline/e2e checks, production build, and deploy. Repeat affected native/network/streaming/memory probe checks after configuration changes. Commit:

```sh
git add src/server src/app/api/profile/route.ts tests/unit/cache-policy.test.ts tests/integration/pipeline-failures.test.ts tests/integration/admission.test.ts tests/integration/ledger.test.ts tests/support/fixtures.ts docs/validation/hosting.md
git commit -m "fix: enforce deadline fallbacks and restricted-data boundaries"
```

### Task 10: Make CI and exact-release verification mandatory

**Milestone/timebox:** M4, hours 44–48. Local lint/type/build checks already ran at deployment gates; automate them now without production keys.

**Files:** Create `.github/workflows/ci.yml`, `scripts/scan-secrets.mjs`, `tests/integration/secret-scan.test.ts`; modify package scripts, Playwright configuration and `README.md` with development commands.

**Interfaces:** Produce `pnpm test:e2e`, `pnpm scan:secrets`, and `pnpm check`; scanner process exit 0 means no findings, nonzero means findings/tool failure. It must never print discovered secret values. CI consumes an isolated Redis service on localhost through a test-only backend for the same Lua operations; production network fetch safety still rejects local targets.

- [ ] RED: create a temporary directory and temporary Git history containing an obviously synthetic secret marker recognized by a dedicated test rule. Run the actual scanner process and assert nonzero exit with redacted output, then repeat a clean fixture expecting zero. Test a marker only in generated client assets and a marker only in an older commit. These are scanner behavior tests; do not search workflow text as a substitute.
- [ ] Run `pnpm test tests/integration/secret-scan.test.ts`; require missing-scan/nonredaction failure before adding the wrapper. GREEN: use a pinned Gitleaks release verified from its official release checksum and run its `git` and `dir` commands with full redaction. The wrapper invokes processes with argument arrays, checks exit codes and passes only allowlisted paths. Equivalent local commands:

```sh
gitleaks git --redact --no-banner --exit-code 1 .
gitleaks dir --redact --no-banner --exit-code 1 src
gitleaks dir --redact --no-banner --exit-code 1 .next/static
```

Also scan tracked configuration/docs/scripts and untracked release-source files through a temporary staging directory built from `git ls-files --cached --others --exclude-standard`; omit ignored local secret files and dependencies, never copy `.env.local`. Scan server build artifacts as well as `.next/static`; redact all results and remove the temporary staging directory within its verified task-specific location. Gitleaks ignore rules may cover known synthetic markers only, with documented exact fingerprints; never disable a provider-key rule globally. An exposed real credential must be revoked/rotated and removed before release.
- [ ] Wire package scripts:

```json
{
  "test:e2e": "playwright test",
  "scan:secrets": "node scripts/scan-secrets.mjs",
  "check": "pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e && pnpm scan:secrets"
}
```

- [ ] Create CI on pull requests and main updates with read-only repository permissions, full history checkout, the host-tested Node version, pinned pnpm and frozen lockfile installation. Provide no production secrets. Start a local Redis service for atomicity tests, install Playwright Chromium, run `pnpm check`, and fail the job on any command failure. Pin workflow actions to reviewed immutable commit SHAs when adding them; log the action release names in comments. Fixture-backed E2E runs the production build with synthetic external HTTP at the transport boundary, not a separate fake application.
- [ ] Ensure Vercel/host release uses the exact checked commit and does not bypass failed CI. Live acceptance is a separate explicitly initiated budget-limited run; ordinary PR CI must never use live API credits. Do not upload screenshots/traces containing transient live images; fixture-based CI artifacts are allowed.
- [ ] Run `pnpm check` locally and CI on the candidate commit. Expected: lint, TypeScript, unit/integration, production build, E2E and secrets all pass independently. Commit:

```sh
git add .github/workflows/ci.yml scripts/scan-secrets.mjs tests/integration/secret-scan.test.ts package.json pnpm-lock.yaml playwright.config.ts README.md
git commit -m "ci: gate release on checks build and redacted secret scans"
```

### Task 11: Verify the deployed product with a bounded live acceptance pass

**Milestone/timebox:** M4, hours 48–58, only after M2 is working and deployed. This is release evidence, not a large evaluation framework.

**Files:** Create `scripts/live-acceptance.ts`, `tests/unit/live-metrics.test.ts`, `docs/validation/live-acceptance.md`; modify `docs/validation/hosting.md`, package script `acceptance:live` and implementation/tests only when a concrete failing case requires correction.

**Interfaces:** `pnpm acceptance:live -- --base-url $env:DEPLOYMENT_URL --max-brave-calls 200 --max-ai-microusd 500000` drives the deployed search UI with Playwright; the UI calls the existing profile endpoint. Cold runs use fresh sessions and `CACHE_READ_ENABLED=false` on the measured deployment of the same code; restore ordinary eligible-cache reads afterward. No browser-accessible budget or cache bypass is introduced. Live inputs remain in an ignored local input file. Disable live screenshots, video and trace persistence. Output retains counts, durations, costs, state and reviewer aggregates only; no restricted source payloads, images or Brave-derived URLs. The ledger remains authoritative even if the script requests larger limits.

- [ ] Before any live run, verify remaining credits and preserve the judging reserve. Set the independent evaluation caps above within remaining authorized credit/cash allowance; stop when either is reached. Twenty runs at a maximum of ten Brave calls need at most 200 calls; do not spend the reserved judging pool during development. If earlier usage leaves too little for the approved matrix, report the incomplete gate rather than purchasing or claiming completion silently.
- [ ] Establish the evaluation input list locally: 7 Kazakhstan institutions (including 2 unfamiliar holdouts never used for tuning), 3 international institutions, plus ambiguous aliases, a multi-campus input and a nonexistent input. No production list is introduced. Holdouts stay holdouts even when they fail.
- [ ] RED: test the small statistics routine with literal durations before reporting timing. Produce `summarizeTimings(values: number[]): { median: number; p95: number; max: number }` in the script, using sorted values and nearest-rank p95; reject empty/nonfinite/negative input.

```ts
it("reports nearest-rank p95 without hiding the slowest small-sample run", () => {
  expect(summarizeTimings([10, 20, 30, 40])).toEqual({ median: 25, p95: 40, max: 40 });
});
```

- [ ] Run this test in `tests/unit/live-metrics.test.ts` before implementation; observe the missing/wrong percentile assertion. GREEN:

```ts
export function summarizeTimings(values: number[]) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0))
    throw new Error("invalid timings");
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  const middle = Math.floor(n / 2);
  return { median: n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1], max: sorted[n - 1] };
}
```

- [ ] Measure 20 cold generation runs including the holdouts, plus 3 concurrent users. Measure from browser submit to actually rendered useful content, waiting for necessary image load events; server elapsed time alone is not this measure. Recheck 10 successive same-session searches and shared-IP sessions with cost-free authored external fixtures first, then sample real judging flow within budget.
- [ ] Review at least 50 image decisions across accepted and rejected candidates, including a wrong campus, visiting event, stock/render and duplicate examples. Review restricted material only during permitted use and retain aggregate outcomes. Rights-permitted test fixtures may record a regression. Never save restricted screenshots/search responses in the repo. Verify click-through publisher links during the live session, categories, dates, evidence strength and real browser delivery.
- [ ] Report together: attribution/category precision, duplicate escapes, category coverage, incomplete-result rate, cost per request, cold median/p95/max, useful-result rate and complete-profile rate. A useful result has at least 3 distinct verified images across at least 2 base categories, including a campus/facility image, plus supported campus text. Partial can fail this threshold; city-only results and fast errors are not successful timings.
- [ ] Compare against spec targets: sampled verified precision ≥95%, no known wrong-university/stock image or exact duplicate, useful-result p95≤30 seconds, and ≥80% of resolved sufficiently documented institutions useful within deadline. Record the source-availability assessment and denominator, every failure and sample size. These are small-sample observations, not calibrated population guarantees. A failed correctness gate requires a regression test and fix before release. If speed/coverage cannot be met in time, disclose measured limitations and leave the failed target visible; do not declare case compliance without evidence.
- [ ] Re-run affected checks after a fix, then all release gates at the final commit. Commit the script, tests and aggregate report:

```sh
git add scripts/live-acceptance.ts tests/unit/live-metrics.test.ts docs/validation/live-acceptance.md docs/validation/hosting.md package.json
git commit -m "test: record bounded cold holdout and concurrency acceptance"
```

### Task 12: Prepare the case deliverables and freeze a verified release

**Milestone/timebox:** M5, hours 58–66; preserve the final 6 hours for failures and submission logistics. Delivery documentation is mandatory case work, not secondary polish.

**Files:** Modify `README.md`; create `docs/submission/demo-script.md`, `docs/submission/slides.md`, `docs/submission/release-checklist.md`, `deliverables/locus-case-01.pdf`. Record actual demo/product/repository links only after they exist. No production code is required for this task unless final verification exposes a bug.

**Interfaces:** README run commands must be the existing `pnpm` scripts. Public links target the actual release commit/deployment. PDF≤8 slides; demo≤3 minutes. Captain's submission form remains a human submission boundary unless separately authorized.

- [ ] Write README with this explicit content order: product and honest limits; live link; local setup/environment variable names; `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm check`; architecture/data flow; sources and permitted use; AI/provider/model and scoring; cache/delivery restrictions; measured latency/cost/coverage; one reproducible test scenario; team roles and all pre-existing/generated components. Do not include keys or restricted evaluation payloads.
- [ ] Write a ≤3-minute demo script: 0:00–0:20 problem/query; 0:20–1:10 actual live generation and one source/score explanation; 1:10–1:45 filters/description; 1:45–2:15 ambiguity or explicit missing evidence; 2:15–2:40 unfamiliar university/architecture and measured timing; 2:40–3:00 limitations and links. Show actual elapsed time; do not edit a slow run to imply it completed in 30 seconds. Record only content permitted for reuse in a shared video.
- [ ] Prepare an eight-slide maximum PDF: problem; live product flow; real-source pipeline; verification/uncertainty; architecture/security/cost; measured results with denominators; limitations/next steps; team/links. Use actual aggregate metrics, not projected claims. Use the presentation/PDF skills at execution if available; render and inspect every slide, ensure sources are legible and confirm page count≤8. Avoid restricted live photos in shareable slides unless permitted.
- [ ] Run `pnpm check` against the exact intended release commit. Disable the capability probe, confirm unauthenticated public access to the application and authorized GitHub repository, confirm secrets remain server-only and check links in a signed-out browser. Verify free access/hosting continuity through results and the September 24 final. Never make an unapproved private repository public merely to complete this checklist; prepare the concrete release materials first if a visibility action needs authorization.
- [ ] Record gate outcomes, known limitations, actual cash expenditure (including prepayment/taxes/hosting), credit remaining and the URLs in `release-checklist.md`. The final commit/build IDs are recorded in the CI/deployment release record after the final commit, avoiding a self-referential commit hash inside its own file. The captain submits on aistartify.com with `LOCUSCASE1` before the official deadline; this plan does not itself submit, message others or purchase anything. Freeze main at the deadline and preserve the same version for the final.
- [ ] Commit the delivery package, run all release gates on that exact final commit, and ensure the deployed build corresponds to it. Use the resulting commit and deployment IDs in the external CI/deployment release record:

```sh
git add README.md docs/submission deliverables/locus-case-01.pdf
git commit -m "docs: prepare LOCUS release demo and technical disclosure"
git rev-parse HEAD
pnpm check
git status --short
```

Expected: clean working tree, documented pass/fail outcomes, no secret or restricted payload in commits. Do not claim a green release if a gate is still red. Documentation edits do not need artificial TDD tests; visually inspect the PDF and actually exercise its links/commands.

## SECONDARY improvements — locked until the full MVP works and is deployed

These are not dependencies of Tasks 1–12 and have **zero hours reserved in the 72-hour critical path**. Start only after M2's complete end-to-end deployment exists, M3/M4 required checks remain on schedule, and the remaining submission/buffer time is protected. No secondary feature can weaken evidence, safety, access, retention or cost gates. A new behavior still requires RED/GREEN tests and a small commit when separately scheduled.

| Deferred improvement | Why deferred | Entry condition and bounded follow-up |
| --- | --- | --- |
| Terra escalation | Another model path consumes evaluation, tokens and latency without repairing missing sources | After release-quality baseline, compare Luna/Terra on the same permitted difficult examples; keep disabled unless meaningful gains are measured. At most 1 call/2 images, ≥7 seconds remaining, ≤5-second call and USD 0.04 profile cap. Existing byte-only adapter and evidence gates remain mandatory |
| Advanced crop matching | Exact plus conservative resize/recompression dedup satisfies the initial similarity path | Add bounded center-crop comparisons (≥70% retained region, SSIM≥0.95) with positive/negative crop fixtures; do not claim arbitrary/off-center crop detection |
| Extensive caching optimization | Ineligible Brave-derived data cannot be cached; cold performance must work first | Basic eligibility enforcement/cache fallback is Task 9. Defer permitted subset assembly, prewarming, cache tuning, single-flight coalescing and background refresh; never introduce a hidden curated index |
| Large-scale evaluation/tuning | Building a benchmark platform delays the working product | Task 11 retains the approved small release matrix after deployment. Defer broad crawls, large labeled datasets, automated annotation tooling and statistical calibration beyond that bounded pass |
| Second AI/search provider | Adds integration and legal/policy branches | Implement only if a measured provider outage/coverage problem justifies it; the provider interface already isolates Luna |
| Extra UI polish and translated UI | Does not repair retrieval/verification failures | Add RU/KZ interface translation, richer motion or comparison views after the English, multilingual-source MVP passes release checks |
| Deep retrieval and richer corroboration | JS/browser galleries, tours, OCR-heavy matching and semantic object search are costly | Keep shallow HTML and supported evidence first; any later access must obey the same crawler and source rules |

Maps, travel estimates, accounts, student reviews, a separate Python backend, queues, vector databases and generated campus images remain outside this MVP. No secondary task may be pulled into M1 because it seems architecturally convenient.

## Plan self-review

This review is performed inline by the plan author, as required by `superpowers:writing-plans`; no subagent review or implementation run is implied.

### Coverage map

| Approved requirement | Concrete tasks / outcome |
| --- | --- |
| Spec §1 / official case / 72 hours / under USD 10 / no curated demo | Milestone order; Tasks 1, 3, 5, 11, 12; ledger and live gate |
| §2 five base categories, all filters, unfamiliar universities, uncertainty | Tasks 6, 8, 11; all eight sections, holdouts and honest states |
| §3 one Next.js Node app and early deployment capability verification | Tasks 1–5; actual deployed native/network/streaming/memory check before depending on host |
| §4 records, API/stream, terminal states and cancellation | Shared interfaces/NDJSON contract; Tasks 5, 8, 9 |
| §5 name/alias/country/campus resolution and revalidated choices | Tasks 3, 6; no university whitelist |
| §6 official-first search, original-page attribution, strict search, respectful crawler | Tasks 2, 3, 6; access checks and image association |
| §7 safe media, exact/visually similar removal and relevant real photos | Tasks 4, 7; advanced crop matching explicitly deferred by latest user priority |
| §8 configurable provider/model, bounded bytes and supported text | Tasks 4, 8; Terra deliberately disabled/secondary |
| §9 score components, gates, caps and uncertainty | Task 4 literal score/negative tests; Task 8 explanations |
| §10 restricted lineage, no persistent image proxy, dates and eligible cache | Tasks 2, 5, 6, 8, 9; missing-image coverage correction |
| §11 deadlines, request work limits, fair rate limits and aggregate budget | Tasks 1, 3, 5, 7, 9, 11; 3 global / 1 session / 120 IP controls |
| §12 UI, facts, failures and delivery gaps | Tasks 5, 8, 9; never fill gaps with unsafe/unrelated/stock content |
| §13 SSRF, prompt/data boundaries, secrets and permitted observability | Tasks 2, 4, 9, 10 |
| §14 TDD, CI, secret scanning, acceptance and sampled thresholds | Every behavior task; Tasks 10–11; no unmeasured compliance claim |
| §15 deployment, history, README, demo, PDF, deadline and final-version freeze | Tasks 1, 5, 8, 12; submission boundary stated |
| §16 mutable provider/host details | Task 1 account/terms checks, Task 4 model smoke, references below |
| Latest request: first milestone is real browser-visible E2E | M1 exit gate, Tasks 1–5, target≤12 hours |
| Latest request: separate optional work and stop before execution | Secondary table and execution boundary; this file is the only new deliverable |

### Consistency and feasibility checks

- The canonical functions/types above are used without alternate names in dependent tasks. Wire cards never contain `ValidatedImage.bytes` or raw discovery records. `fatal` and `final` are mutually terminal; malformed EOF cannot be a successful final result.
- Ordinary query body limit is 2 KiB; campus-selection requests permit 12 KiB to carry the maximum 8 KiB authenticated token. Both remain explicitly bounded. The UUID wire example uses runtime-valid UUIDs in tests.
- Test factories and external transport doubles belong to `tests/support/fixtures.ts`; all their signatures and supplied scenario behavior are defined in their owning tasks. They do not become production fallbacks.
- Review corrections incorporated: selection body/token bounds are consistent; M1 does not pretend a perceptual hash exists before Task 7; the shared Lua has a defined transport seam for real atomicity tests; live timings use browser rendering; merged policies preserve attribution obligations; final commit IDs are recorded externally after the final commit.
- Paid work is guarded in M1, not postponed to resilience work. Decoder concurrency is 2 even though outbound concurrency is 6. Search/AI retries share attempt and cost limits rather than multiplying them.
- Exact and ordinary near-duplicate removal remain MUST-HAVE. Only advanced crop matching moves out, per the latest instruction. Basic policy-aware cache handling remains; optimization is secondary. The approved bounded release matrix occurs after the full deployment; large evaluation tooling is secondary.
- Every implementation task names files, consumed/produced interfaces, concrete behavior tests, failure/pass commands and a frequent commit. Documentation/material tasks use direct inspection instead of contrived tests.
- M1 has an integration checkpoint at hour 6 and a hard priority on visible live output by hour 12. Remaining timeboxes preserve 6 hours of final buffer. Account eligibility, source display permission and actual performance are measured risks, not assertions that the plan has already solved them.

### Documentation consulted for planning

Use the spec's reference list for Brave terms/pricing, OpenAI models, Wikidata and host eligibility. Reconfirm mutable account details when integrating. Additional primary references checked while writing this plan:

- [Next.js installation and separate lint/build commands](https://nextjs.org/docs/app/getting-started/installation).
- [Next.js route handlers and streaming responses](https://nextjs.org/docs/app/api-reference/file-conventions/route).
- [undici custom connector boundary](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md).
- [sharp input limits and image constructor](https://sharp.pixelplumbing.com/api-constructor/).
- [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision) and [Luna model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
- [SSIM numerical library and its archived status](https://github.com/obartra/ssim).
- [Gitleaks commands and redaction](https://github.com/gitleaks/gitleaks#usage).

**Review result:** Requirements are mapped, intentionally deferred items are explicit, and the plan stops at an execution handoff. No production implementation, integration result, benchmark or deployment is claimed by this document.
