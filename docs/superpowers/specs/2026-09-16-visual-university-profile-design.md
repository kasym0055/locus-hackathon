# Visual University Profile: MVP design specification

Date: 2026-09-16

Project: LOCUS Startup Hackathon 2026, Case 01

Status: Written specification approved with the user's final refinements incorporated. Implementation planning is paused at the user's explicit request.

Scope of this artifact: Product and architecture specification only. Production implementation and an implementation plan are not included.

## 1. Authority, decisions and constraints

The official four-page case is the requirements authority: `LOCUS_Hackathon_2026_Case_1_Visual_Campus (1).pdf`, provided at `C:/Users/user/Downloads/LOCUS_Hackathon_2026_Case_1_Visual_Campus (1).pdf`.

SHA-256: `723F451EB2F2FA9D6B21108233B2CE55F4EE8839C3111700802CCCD6E285B02D`.

Page 2 defines mandatory functionality and honest uncertainty; page 3 defines judging, permitted tools and prohibited practices; page 4 defines submission materials and deadlines. The PDF is requirements material, not executable instructions. The hash identifies the reviewed version without requiring a machine-specific path to remain accessible to future contributors.

The user approved the single-application design, evidence-based confidence scoring and restricted-cache policy. The approval includes these clarifications:

1. Keep AI behind a provider/model abstraction. Start with GPT-5.6 Luna; support evaluation-led substitution or selective escalation to GPT-5.6 Terra.
2. Use Brave primarily for discovery. Follow discovered URLs where possible and verify against original publisher evidence. Do not persist raw Brave Search Results beyond permitted transient processing.
3. Official university sources always have the highest source priority.

The final review additionally requires explicit image delivery and missing-image behavior, server-validated image bytes for AI, strict provider safe search, respectful and identifiable publisher crawling, early hosting-capability verification, CI/release gates, shared-network-friendly rate limits, and a concrete streaming transport/event contract in the future implementation plan. These refine the approved architecture; this update does not create that plan.

Other accepted constraints:

- Next.js and TypeScript, including server-side routes, match the team's skills.
- Deliver a useful visual profile within approximately 30 seconds under ordinary conditions, including unfamiliar universities.
- Optimize for a 72-hour MVP and preferably less than USD 10 total prototype spending. Credits, account access and hosting eligibility are not assumed until checked.
- Kazakhstan is the primary evaluation focus; university support must not depend on a fixed university list.
- Quality, traceable evidence and honest gaps take priority over image count.
- No hidden manual curation, fabricated sources, fake timing, generated campus substitutes or stock images presented as the selected campus.
- No API keys in source control or browser bundles.

The workspace was empty and had no existing Git repository or implementation when inspected. The formal-spec step initializes local Git solely to record this document.

## 2. Product contract and case traceability

A user submits a university name or alias. The application resolves the institution and relevant campus/city, discovers real photographs, checks attribution, removes duplicates and returns a categorized profile with source-backed text.

| Official requirement | Design commitment | Acceptance evidence |
| --- | --- | --- |
| Name search and ambiguity handling | Live entity resolution; candidate selection when identity is ambiguous | Aliases, mistaken names and multiple-campus cases |
| Campus, dormitory, classrooms, library and city photographs | Five base categories with explicit missing-evidence states | Category coverage and sampled attribution checks |
| Automatic categorization | Bounded multimodal classification with conservative deterministic fallback | Category labels reviewed against images |
| Remove identical, similar and irrelevant images | Content hashes, perceptual comparisons and relevance gates | Exact, recompressed, resized, cropped and wrong-location examples |
| Verify university, object or city membership | Image-specific original-source evidence plus deterministic policy | Reviewable supporting evidence on every verified card |
| Clickable source and dates where possible | Publisher-page link; typed publication, retrieval and capture dates | Link checks and date provenance checks |
| Short source-backed description | Supported facts with claim-level citations | Every descriptive claim maps to fetched evidence |
| Dormitory, sport, laboratories and student-life filters | All required filters remain available, including empty states | UI scenario covering every filter |
| Useful result within 30 seconds; unfamiliar university | Bounded live pipeline; cold-run timing and holdout evaluation | Browser timing, completeness and failure rate reported together |
| Honest uncertainty and permitted source use | Verification gates, uncertainty labels and source-specific usage policy | Negative examples, outage scenarios and cache inspection |

The eight categories are `campus`, `dormitory`, `classrooms`, `library`, `laboratories`, `sport`, `student_life` and `city`. Each accepted image has one primary category and optional supported filter tags. Tags do not create duplicate gallery cards. A city photograph proves city context only; it cannot count as a university facility.

The normal presentation target is 8-16 distinct supported images, with at least one in each base category when sufficient evidence exists. These numbers are product targets, not permission to weaken acceptance rules. All eight sections exist even when some contain no accepted photos.

Verification measures attribution to a source and place. It is not a forensic guarantee of authenticity or proof of current conditions.

Out of MVP scope: comparison tools, maps and travel calculations, accounts, student reviews, social-network login, deep crawls, general-purpose browser automation, a prebuilt university image index, self-hosted models, vector databases and automatic image generation. English is the initial UI language; search and source interpretation support English, Russian and Kazakh. A translated UI can be added later without changing retrieval contracts.

## 3. Architecture decision

| Approach | Complexity and reliability | Cost and speed | 72-hour decision |
| --- | --- | --- | --- |
| Single Next.js application with bounded pipeline | One language and deployment; explicit module boundaries and failure handling | Low operational overhead; capped calls; live latency requires measurement | Selected |
| Next.js frontend plus Python backend | Better access to some image libraries, but two deployments and another network boundary | Similar external API costs plus backend operations | Defer until image-processing needs justify it |
| Automated crawler and persistent prebuilt index | Ingestion, rights management, refresh scheduling and storage required | Fast for indexed entities; new universities still need live retrieval | Too much infrastructure for MVP |

Use Next.js with Node.js server routes. Native image decoding/resizing and hashing run on the server, not in an Edge runtime. The browser owns search, clarification, progress and gallery presentation. The server owns keys, retrieval, evidence, model calls, scoring and budgets.

Hosting candidate: Vercel, with account eligibility checked before deployment. Hobby is limited to personal, non-commercial use; an ineligible project must select a compatible host within the same budget rather than silently rely on that tier. Upstash Free Redis is the proposed shared metadata/counter store. Host-specific details remain outside domain modules. See references R7-R8.

### Early deployment capability verification

The future implementation plan must place a minimal deployed capability check before building the retrieval pipeline around a hosting provider. A local development-server check is insufficient. Confirm on the actual candidate host/account:

- Node.js runtime and supported version, including the safe fetcher's required network controls.
- Native image-processing package loading, raster decode/resize/hash operations, and binary compatibility in the deployed build.
- Incremental response delivery without buffering, plus disconnect/cancellation behavior for the selected streaming transport.
- Configurable function duration sufficient for the 27-second processing window and stream completion, including platform overhead.
- Available memory and observed peak use under bounded image decoding and the intended concurrent-request load.
- Outbound connection/concurrency limits, effective per-origin controls, timeouts and abort behavior.

Record the measured capability result and plan/account configuration without secrets. If a required capability fails, adjust the provider or bounded limits before committing the rest of implementation to that hosting assumption. Repeat affected checks after relevant host, runtime, native-library or streaming-configuration changes. This is a required early implementation activity, not a probe performed during specification editing.

No durable job queue is required. A request runs while its response stream is open, stops at its deadline, and produces a terminal result. Nothing essential continues in an untracked background task after the response ends.

### Module boundaries

| Module | Responsibility and output | Dependencies |
| --- | --- | --- |
| Request coordinator | Validate request; own deadline, stage transitions and call allowances | Modules below; clock; budget store |
| Entity resolver | Produce supported university/campus identities or clarification candidates | Eligible identity cache; Wikidata adapter; discovery adapter; publisher fetcher |
| Discovery adapter | Apply strongest appropriate safe search; find potential pages/images and return transient discovery candidates | Brave Web/Image Search initially |
| Publisher evidence collector | Respect access policy; fetch original pages and bind text, captions, image references and typed dates | Identifiable safe fetcher; HTML parser; robots/publisher policy |
| Image processor | Validate fetched bytes, decode, filter, deduplicate and produce bounded AI image inputs | Safe fetcher; image library; content/perceptual hashes |
| AI adapter | Consume validated image bytes; return schema-validated visual assessments or supported text claims | Configured provider/model; deadline and cost allowance; no discovered-URL fetching |
| Verification policy | Compute evidence scores, enforce gates and explain decisions | Entity, publisher evidence and visual assessments |
| Profile assembler | Build categories, citations, coverage and terminal status | Accepted decisions; supported text facts |
| Cache/budget service | Enforce retention, expiry, shared spending reservations and rate limits | Redis; versioned policy |

Changing a search provider or AI model must not require rewriting scoring, the UI or publisher evidence extraction. Do not build a generic plugin framework: one implementation per needed adapter is sufficient initially.

## 4. Request and data contracts

One profile request accepts a query, an optional explicit country/city hint, a display language and, after clarification, a selected candidate. Client-provided identity, domain and URL data remain untrusted; revalidate or verify server-issued candidate state before fetching.

For an unambiguous query, resolution and generation share the same end-to-end request deadline. For an ambiguous query, return candidate names, cities and official-domain evidence promptly. A subsequent selection starts a generation request. Report initial resolution time, generation time and total interaction time separately; do not silently exclude clarification from claims about the user journey.

Stream stage events and only accepted gallery decisions. Stages are resolving, official retrieval, fallback retrieval, checking and assembling. They are operational facts, not fabricated percentages. A terminal event replaces provisional coverage with the final profile state. Cancellation aborts outstanding requests.

### Streaming contract required in the implementation plan

The future implementation plan must select exactly one transport, SSE or streamed NDJSON, and specify its request method, content type, framing and browser consumption. This is deliberately assigned to planning, as requested; this spec update does not select or implement the transport.

That plan must define a versioned event envelope, request correlation, monotonic event ordering, typed payloads and validation rules. It must cover stage progress, resolved identity/clarification, accepted image additions or revisions, warnings, final profile state and fatal failure. Specify how clients handle split network chunks, duplicate/stale events, malformed frames, premature disconnects, cancellation and exactly one terminal outcome. Reconnection must not silently start another paid generation. Event payloads must respect the restricted-data policy and must not expose raw search payloads, image bytes or secrets. The host capability check must exercise the selected transport before the main pipeline depends on it.

Terminal states:

- `needs_selection`: credible competing institutions or campuses require user choice.
- `not_found`: completed discovery produces no sufficiently supported institution identity. Dependency failure alone is `unavailable`, not evidence that the university does not exist.
- `complete`: all five base photo categories have a verified image, required category/filter controls exist, and the source-backed description is available. Additional categories can still have explicit gaps.
- `partial`: at least one verified photograph is available, but complete-profile conditions are not met. Show omissions and provider failures. A partial profile can still fail the separate useful-result threshold in section 14.
- `insufficient_evidence`: identity is known but no verified photograph can be shown. Supported text/source links may still be presented. This is not a successful visual-profile result.
- `unavailable`: dependencies or budget prevent meaningful retrieval and no eligible fallback is available.

### Logical records

These are interface contracts, not a requirement to persist every record or introduce a relational database.

| Record | Required information |
| --- | --- |
| University identity | Internal identity, canonical name, evidenced aliases, campus, city/country, official domains, identity evidence, resolution status |
| Discovery candidate | Provider, query context, potential page/image URLs, discovery time and restricted-retention lineage; transient by default |
| Publisher evidence | Source ID, final publisher-page URL, retrieved time, relevant excerpt/caption, image-to-page association, typed source dates, publisher authority and usage policy |
| Image candidate | Candidate ID, admitted display URL if permitted, validated byte-input reference, dimensions, content/perceptual hashes, evidence IDs, delivery/retention policy, facility/location scope and duplicate-group membership |
| Visual assessment | Image ID, category/tags, visible cues, safety/relevance flags, cited evidence IDs, conflicts, interpretation status, provider/model/prompt/schema versions and usage |
| Image decision | Accepted/uncertain/withheld/rejected status, component scores, caps/gates, reasons, source references and supported dates |
| Profile | Resolved identity, category cards, cited description, coverage, terminal state, warnings, live/cache provenance and timings |
| Usage record | Request ID, counts, reserved/actual costs, provider/model IDs, stage durations and error codes; no restricted result payloads |

References must resolve within the current evidence set. Model-generated source IDs, unknown image IDs or invented URLs are invalid. Different model outputs cannot attach to a candidate merely because their position in a batch matches.

## 5. University and campus resolution

Normalize case, Unicode and spacing conservatively, while retaining the original query. Search eligible identity records first. Use a bounded Wikidata lookup for names, aliases and candidate websites; use Brave discovery when information is missing or competing candidates need context. Wikidata structured data is reusable under CC0, but can be incomplete or outdated (R6).

Verify identity against current official pages: institution name, contact/location information and consistency with independent registry/discovery evidence. An educational-looking domain suffix or search ranking alone does not establish official status. A model can extract proposed fields from supplied text; deterministic policy checks evidence and selects resolved versus ambiguous state.

Kazakhstan is an explicitly visible default search preference, not a hard restriction. Short aliases such as NU can have several meanings. Do not create a global alias-to-university shortcut that suppresses competing identities. Identity/cache keys include applicable country and campus context.

When a university has several campuses in different cities, require campus selection unless the query identifies one. Branch-campus evidence must not be merged with the main campus. Record the university-to-campus-to-city relationship before accepting location-specific images.

Use general source parsing and language vocabulary. NU, AITU and KBTU are evaluation examples, never a production whitelist or preselected image dataset. If both live resolution services fail, only an eligible, evidenced identity record can support continued retrieval; never invent a domain.

## 6. Official-source-first discovery and publisher verification

### Retrieval order

1. Fetch the confirmed official homepage or relevant eligible cached page and inspect high-value navigation links. Prioritize campus/facilities, accommodation, library, laboratories, sport, galleries and student life. Use shallow traversal, not a full crawl.
2. When navigation is insufficient, use official-domain-restricted discovery queries to find original university pages. Official department and library subdomains qualify when their relationship is supported.
3. After the initial official pass, use broader Brave Web/Image Search only for unresolved coverage, failed official retrieval or insufficient candidates. For city images, seek attributable city/place sources; university sources remain first choice when relevant.
4. Follow discovered publisher URLs where possible. Fetch the originating page and bind each image to its caption, nearby text, gallery grouping or other explicit attribution.
5. Rank accepted candidates by evidence strength and relevant official provenance before visual appeal or volume. A strong external source may beat an unrelated official-domain image; official priority never bypasses evidence gates.

The query planner uses full university name, selected city/campus and category vocabulary. It chooses a useful source language instead of executing every language/category combination. Russian and Kazakh aliases and terms are supported even when a provider lacks a corresponding locale parameter; use only supported provider parameters. Preserve spellcheck changes as uncertainty signals rather than silently changing the institution.

Set Brave Web and Image Search `safesearch` explicitly to `strict`; do not depend on endpoint defaults (R3). A replacement provider must use its strongest appropriate supported equivalent. Never relax safe search to fill missing categories. Treat provider offensive-content warnings as reasons to withhold results until content screening clears them, not as permission to display them. Search filtering is one layer: all image paths, including direct official retrieval, must reject unsafe imagery and content unrelated to the selected university, facilities, student life or city. Legitimate city context remains in scope. Unresolved content-safety concerns are withheld from both the main and uncertain galleries.

Brave is discovery evidence, not proof of image membership. Its snippets, ranking, confidence fields and crawl timestamps do not establish publisher attribution or publication dates. The default high-confidence path requires an accessible original publisher page. If that page cannot be inspected and no eligible prior publisher evidence exists, the candidate cannot receive a verified label.

### Publisher access and crawler identity

The shallow crawler checks applicable `robots.txt` rules and publisher access restrictions before retrieving content, including relevant image origins. It honors disallow rules, publisher prohibitions, applicable crawl pacing, access denials, rate-limit responses and Retry-After. It does not bypass login, paywalls, robots restrictions or anti-bot challenges. If access permission cannot be established within the deadline, skip the source and expose the evidence gap; discovery through Brave does not override a publisher restriction.

Publisher page, image and access-policy requests use an identifiable User-Agent containing the application name/version and a real project information/contact URL configured before live crawling. Do not impersonate a browser or omit crawler identity to evade restrictions. Missing crawler identity disables live publisher crawling. Access-policy lookups share the safe fetcher's concurrency, response-size and absolute-time limits; source-required pacing may reduce work further. Honor stricter publisher limits even when the application has unused capacity.

### Evidence binding

Support image references in ordinary HTML, responsive sources, lazy-load attributes and explicit metadata. Associate evidence narrowly enough to distinguish the actual photo from logos, navigation assets and unrelated images elsewhere in the article. A generic university footer is not an image caption. An official article about students visiting another institution is evidence of that visit, not of the selected campus.

An image hosted on a CDN can inherit publisher provenance from the official page that embeds and explicitly attributes it. Its CDN hostname does not establish university membership. Redirect destinations and extracted URLs must pass safe-fetch checks.

JavaScript-only galleries, login-only social content, interactive tours and PDF image extraction are outside the initial fast path. Seek alternative accessible publisher pages within the same deadline and expose missing evidence if none exist.

Source verification and usage permission are separate checks. Follow source access rules; do not bypass blocks. Use an image/thumbnail only through a permitted display mechanism. A citation alone is not a reuse license. Record author/license requirements where applicable; if a permitted display basis cannot be established, show a source link and missing-photo state rather than imply that public accessibility grants unrestricted reuse.

Following a discovered URL improves evidence quality. It does not automatically remove Brave lineage restrictions or grant persistent storage rights; section 10 governs retention.

## 7. Image filtering and deduplication

Initial limits per generation request: collect at most 40 candidate records, download at most 24 image candidates, and submit at most 16 distinct images to normal vision assessment. Select across categories so a large campus gallery cannot consume the entire shortlist.

Before AI:

- Fetch candidate images only through the server-side safe fetcher. Validate content type against actual bytes, require successful raster decode, bound input bytes and decoded pixels, reject tiny/icon-like assets, and produce bounded normalized image bytes. Reject unsupported/active formats rather than passing them through to a provider.
- Remove identical content hashes. URL canonicalization may remove known tracking fields, but must preserve resource-changing parameters and signed URLs.
- Compare perceptual hashes to propose near-duplicate pairs. Confirm using normalized similarity and image geometry before merging; two angles of the same building are not automatically duplicates.
- Use a bounded crop-aware comparison for probable crop variants. Uncertain comparisons remain separate until a supported decision can be made; do not claim perfect crop detection.
- Remove explicit stock-provider content, logos, maps, posters, known non-photo renders, unsafe imagery and unrelated visuals from the real-photo gallery. Use available provider/source safety signals before AI; the bounded visual assessment can flag additional cases before any display. An absent watermark does not prove authenticity, and an absent provider warning does not prove safety.

The initial perceptual candidate threshold is Hamming distance at most 6 for a 64-bit hash; it proposes comparison, not automatic deletion. For ordinary resized/recompressed pairs, initially require aspect ratios within 5% and structural similarity (SSIM) of at least 0.95 after normalization to a common 128-pixel-long-edge grayscale comparison. A bounded center-crop comparison can propose crop variants only when the retained region covers at least 70% of each original; require the same SSIM threshold on matched regions. More aggressive or off-center crops remain a documented limitation. These initial thresholds are versioned and calibrated on rights-permitted fixtures during implementation. Conservative uncertainty is the default until that calibration passes.

Choose the best-supported usable representative, then image quality, within each confirmed duplicate group. Do not count duplicate sources as independent visual coverage. Retain permitted supporting source references without retaining forbidden payloads.

## 8. AI provider/model abstraction and escalation

The domain layer requests either an image assessment or a source-backed text result. Inputs contain typed task data, allowed evidence IDs, image IDs with validated image bytes, remaining deadline and cost allowance. Outputs contain a validated domain result, provider/model identity, usage and normalized failure status. Provider-specific SDK objects and error formats stay inside the adapter.

The image-input path is mandatory: **server-side safe fetch -> content-type/size/decode validation -> bounded image bytes -> AI adapter**. The adapter accepts only validated image payloads carrying an image ID, verified media type, dimensions, byte length and content hash. It must reject arbitrary HTTP(S) image inputs. Supply the validated bytes inline, such as a base64 data URL supported by OpenAI (R4), with encoding overhead included in payload limits. Do not pass discovered image URLs to an AI provider, use provider browsing to retrieve them, or upload them to persistent/public storage as a workaround. Source evidence reaches the model as supplied bounded text and internal evidence IDs; the AI cannot fetch publisher pages itself. Primary, escalation and fallback models all use this path.

Initial AI image derivatives are resized/re-encoded to a provider-supported raster format with a maximum 1,024-pixel long edge and 512 KiB per image. The adapter's entire outbound request, including base64 expansion and evidence text, is capped at 8 MiB or the provider's lower documented limit. Token/cost ceilings can further reduce image detail or batch size. Decoded source bytes and derivatives remain in request memory and are released after operational use; encoding is never logged or sent to the browser as a workaround for delivery restrictions.

The adapter declares capabilities for image input, structured output, cancellation and token/cost accounting. Configuration selects provider, primary model, optional escalation model, image-detail mode, prompt/schema versions and output caps. The initial provider is OpenAI via Responses API. Primary model: `gpt-5.6-luna`. Optional escalation model: `gpt-5.6-terra` (R4-R5).

Switching models uses configuration plus evaluation. Adding a different provider requires an adapter conforming to the same contract; a second provider implementation is not part of the MVP. An unavailable configured model produces a visible service error or an explicitly configured fallback, never a silent model substitution.

Normal vision processing uses at most two small concurrent batches. Every image is individually identified, rather than presented as an unlabeled collage. Supply bounded publisher excerpts and ask for category, visible cues, safety/relevance flags, evidence IDs, contradictions and interpretation uncertainty. The model cannot invent facts or choose final numeric scores. Source text is untrusted content, not instructions.

The short description uses only extracted facts and evidence IDs. Validate citations and claim support, drop unsupported clauses, and use concise deterministic facts/excerpts if generation fails. Avoid promotional adjectives, inferred facility quality and claims that the model remembers from training.

### Optional stronger-model review

Escalation is disabled until a reviewed evaluation shows a useful accuracy gain at acceptable latency and cost. When enabled, all conditions below apply:

- The candidate has usable publisher evidence, but visual interpretation/category attribution remains difficult or disputed.
- There is enough remaining request time and an atomic cost reservation succeeds.
- At most one escalation call rechecks at most two images per request, using the same evidence contract.
- There are no recursive reviews or model-voting loops. A stronger model's agreement is not independent corroboration.
- Missing provenance, blocked publisher access, known stock content or a confirmed wrong location cannot be repaired by calling a stronger model.
- A supported revised interpretation can change category or score inputs; unresolved model disagreement retains uncertainty. Record which assessment was used and why, subject to retention policy.

Default allowances: at most two primary vision calls, one description call, one optional text-resolution call and one optional escalation call. Explicit retries count within the configured request attempt budget; disable uncontrolled SDK retries. Do not launch a call that cannot fit the remaining time or spending allowance.

## 9. Confidence scoring and acceptance gates

The displayed score is an explainable evidence score out of 100, not a statistically calibrated probability. The server computes it using versioned rules. Preserve identity certainty, category interpretation and photo freshness separately.

| Component | Discrete points | Rule |
| --- | --- | --- |
| Publisher authority | 25 / 15 / 0 | Confirmed official university publisher or relevant official city authority / attributable independent publisher / unknown or unattributable |
| Image-specific attribution | 45 / 25 / 10 / 0 | Explicit image-to-selected-location attribution / tightly scoped unambiguous gallery attribution / general relevant page mention only / absent |
| Additional corroboration | 20 / 10 / 0 | Independent attributable source connects the same image or uniquely identifiable object to the location / distinctive visible identifier matches separately established location evidence / absent |
| Visual consistency | 10 / 5 / 0 | Clear category fit with no supported conflict / broadly plausible but ambiguous / unassessed or unsupported |

Add component points, then apply gates and caps. Every awarded component requires an evidence reference or a documented visual observation. The same caption cannot supply both attribution and independent corroboration. Reposts, syndicated articles, duplicate images and multiple model outputs are not independent publishers. Visible text adds corroboration only if compared with evidence beyond the text already used for attribution.

Hard rejection overrides all scores for a supported wrong university/campus/city, explicit stock substitution, known render/generated image, unsafe imagery, irrelevant content, or forbidden usage. Suspicion without a confirmed contradiction yields withholding/uncertainty instead of a fabricated definitive finding, except that unresolved content-safety concerns are always withheld rather than shown as uncertain photos.

Before any verified display, require: resolved entity/campus; usable image and originating source link; permitted display; image-specific location support; supported category; and no unresolved location contradiction. Then require either direct official attribution or an equivalent attribution supported by independent attributable publishers. If this final provenance gate fails, cap the score at 79 and explain the cap.

- 80-100 with all gates satisfied: **Verified by source**.
- 60-79: **Uncertain**, in a separate opt-in section with missing-evidence reasons. Does not count toward verified coverage.
- Below 60: **Withheld** from the visual gallery.
- Hard rejection: excluded, with an internal reason code; never promoted by a strong model answer.

Examples:

- Official domain, general page mention and visually plausible classroom: 25 + 10 + 0 + 5 = 40; withheld.
- Official residence page explicitly identifies its embedded dormitory photo, with clear category fit: 25 + 45 + 0 + 10 = 80; verified if all gates pass.
- Attributable independent article explicitly labels an image, without corroboration: 15 + 45 + 0 + 10 = 70; uncertain.
- The same third-party image/object independently corroborated: 15 + 45 + 20 + 10 = 90; may pass the provenance gate.
- An official photo of a partner campus visited by students: reject for location conflict regardless of possible component totals.

Thresholds are initial policy, not measured performance. Calibration uses reviewed examples and tracks false verified results. Do not lower thresholds to fill categories or hide an integration failure.

## 10. Restricted-cache and date policy

Brave's current terms restrict persistent Search Result storage and permit transient operational storage. The application therefore disables persistent raw-result caching by default, including result URLs/snippets/thumbnails retained as a substitute search index. Provider documentation and the active account terms determine permissions; this spec does not assume an enterprise or special storage agreement (R1-R3).

Every record has an origin, policy version and retention class:

| Class | Treatment |
| --- | --- |
| `transient_only` | Necessary active-request/browser-session processing only; no Redis profile cache, browser persistent storage, CDN cache, analytics payload, fixture or application-log retention |
| `cache_permitted` | Store only permitted fields with expiry and evidence of the permission basis |
| `disallowed` | Do not ingest/display or retain the prohibited content |

Default unknown retention permission to `transient_only`. Provider-derived lineage remains visible when the publisher page is fetched. Original publisher evidence can be cached only when its own permitted retention basis and applicable provider restrictions are satisfied. Re-fetching, paraphrasing, hashing or running AI over restricted results does not by itself create a storage exception. Derived profiles and assessments inherit applicable restrictions.

Use request memory for transient data; release it when operational use ends and avoid persistent browser storage. Responses carrying restricted results use `no-store` and bypass framework/CDN response caches. Do not store restricted image data in an automatic image-optimization cache. Configure logs/traces and AI request storage consistently with source policy; where permissible processing cannot be established, skip that path. OpenAI request persistence is disabled where supported; this setting is not a promise that all provider operational retention disappears.

### Image delivery strategy

Image analysis and browser delivery are separate paths. AI always receives server-validated bounded bytes under section 8. For the gallery, prefer direct browser display of an admitted remote image/thumbnail URL when publisher/provider display terms, source access rules and retention requirements permit it. Only expose URLs of screened candidates, not arbitrary discovered URLs. Use a direct image element or equivalent explicitly unoptimized delivery; do not route transient/restricted images through Next.js image optimization, a persistent application proxy, object storage, or a framework/CDN image cache. The MVP does not add an image proxy to overcome hotlink protection.

Do not prefetch/cache restricted images in a service worker, Cache Storage, local storage or IndexedDB. Direct remote requests are governed by the remote server's response headers and the browser; the application cannot promise to override those caches. If required retention/display conditions cannot be met through direct delivery, do not load the image. Persistently caching an eligible image later would require an explicit permitted policy; it is not the default delivery strategy.

If direct display is prohibited, hotlinking is blocked, the URL expires, or loading fails, show the original publisher source link and an explicit **Image unavailable** or **Display not permitted** state. Do not bypass the restriction, silently proxy/cache the image, or substitute a stock/generated image. Remove unavailable images from visible-photo and category-coverage counts, and downgrade the rendered profile's completeness when necessary. A previously computed attribution score describes evidence, not successful current delivery.

Eligible persistent cache defaults:

- Freely reusable/evidenced university identity: seven days, keyed by identity, campus and relevant query context.
- Publisher evidence and profiles: at most 24 hours, or a shorter source-required limit.
- Image assessment: no longer than its evidence eligibility/expiry; key by entity/campus, image content hash, evidence fingerprint and provider/model/prompt/schema versions.
- Negative transient service outcomes: do not create a durable university-not-found record from a timeout.

A profile is persistently cacheable only when all included fields are eligible. A separately assembled eligible subset may be cached, but its missing coverage remains explicit. A cache hit identifies the last evidence check. Expired or known-broken evidence is not silently presented as fresh verification.

Publication time belongs to the publisher page or image as evidenced. Retrieval time records the application's actual fetch. Capture time exists only with supported photo-specific evidence. Provider crawl time, HTTP Last-Modified, a copyright footer or a year in an upload path must not be presented as the photo's publication/capture date. Missing dates remain missing; old supported dates show a freshness notice without changing location identity.

## 11. Latency, limits and cost

The server has an absolute 27-second processing deadline from receipt of a generation request, reserving approximately three seconds for delivery and browser rendering. The product's measured target is at most 30 seconds from submission to a useful rendered result under ordinary conditions. Neither server cancellation nor a fast empty state proves the useful-result target.

| Approximate elapsed time | Overlapping work |
| --- | --- |
| 0-4 seconds | Identity resolution and eligible cache lookup |
| 4-12 seconds | Official pages and early candidate filtering |
| 9-17 seconds | Targeted fallback after official evidence/gaps are assessed; shortlist finalization |
| 14-25 seconds | Vision batches, scoring and optional bounded review |
| 23-27 seconds | Supported description and final assembly |
| 27-30 seconds | Delivery and rendering margin |

These are design budgets, not benchmark results. Slower earlier stages reduce later work. The coordinator carries an absolute deadline into every fetch and model call. Finish with supported material rather than waiting for the slowest provider. No external discovery is launched merely because nine seconds elapsed if an official-source pass has not been attempted.

Initial per-request limits:

- Search: target 6-8 Brave requests, maximum 10 including retries.
- Publisher pages: maximum 8 fetched content pages, maximum 6 concurrent outbound fetches and 2 concurrent requests per publisher host. Access-policy lookups are separately capped at 8 origin checks, share these concurrency/deadline limits, and can reduce the content-page budget in practice. A new origin that cannot be checked within the allowance is skipped.
- Individual publisher/image request: approximately 3 seconds, bounded by remaining overall time; maximum 2 MB decoded HTML, 5 MB compressed image and 20 megapixels decoded image.
- Image candidates: 40 metadata records, 24 downloads and 16 normal vision inputs; primary batches contain at most 8 images each.
- AI: maximum 2 concurrent calls; primary vision timeout at most 10 seconds; description at most 4 seconds; optional resolver at most 2 seconds. Optional escalation starts only with at least 7 seconds remaining and has at most a 5-second timeout.
- Global admission: initially at most 3 generation pipelines concurrently; excess requests receive a clear busy response instead of waiting in a queue that defeats the deadline.
- Abuse control: a per-anonymous-session token bucket with capacity 10 and refill rate 20 generation requests per minute, plus at most one active generation per session. A coarse per-IP guard allows up to 120 submitted profile requests per rolling minute. The earlier 3-requests-per-minute-per-IP rule is removed; shared campus/judging networks must not be treated as one user.

The coordinator must reserve source-page capacity for fallback evidence and candidate capacity for different categories. Batch work shares the same request limits; parallelism never multiplies the allowance.

Anonymous session IDs are server-issued and do not require accounts. Session limits improve fairness but are not trusted as cost security: global concurrency, atomic spending reservations and provider-call caps remain authoritative even if clients rotate sessions or IPs. Trust client-IP forwarding only from the deployment platform's configured trusted proxy. Limit rejections provide a retry interval and do not dispatch paid work. The UI prevents accidental duplicate submissions and supports another university search as soon as the previous generation ends. No judge-specific bypass can disable budget or concurrency controls. Test at least 10 successive searches from one session and several separate sessions sharing one IP; tune only with measured behavior while preserving the cost ceilings.

### Spending controls

Current published reference prices are USD 5 per 1,000 Brave Search requests with USD 5 monthly credits (R1), Luna USD 0.20 input / 1.20 output per million tokens (R4), and Terra USD 2 input / 12 output per million tokens (R5). Image inputs are billable; estimate them using the configured model's documented rules. Prices, credits and account limits require confirmation before live use.

Illustrative usage, not a guarantee: 100 cold profiles at 8 searches consume 800 Search requests; 15,000 billed input tokens plus 3,000 output tokens on Luna cost USD 0.0066 per profile. Actual image tokenization, retries and escalation change that figure. Reserve at least 200 available Brave calls for judging if the account starts with the full 1,000-request credit allowance.

Initial operating policy:

- Use available Brave credits first; paid overages and automatic top-ups are off by default.
- Plan for a small OpenAI balance, such as USD 5 if compatible with the account's funding minimum. No OpenAI promotional credit is assumed.
- Keep total actual prototype cash expenditure below USD 10 where feasible, counting funding minimums, taxes and hosting. Do not equate unused prepaid balance with zero cash expenditure.
- Maintain separate counters for gross provider usage, free-credit consumption, prepaid spending and remaining authorized paid budget.
- Reserve worst-case call cost atomically before dispatch; reconcile actual usage after completion. Keep a conservative reservation for timed-out calls whose billing is unknown.
- Initial AI ceilings are USD 0.02 per normal profile and USD 0.04 per profile when evaluated escalation is enabled. Set a separate aggregate AI usage allowance within the funded balance, initially USD 4, leaving reconciliation headroom.
- Configure per-task output limits and provider-specific token estimates to enforce those ceilings. Set reasoning to none/low where supported and count billed reasoning tokens; a task that cannot fit is skipped or reduced.
- Shared counters survive serverless instances. If the shared budget store fails, fail closed for fresh paid work; an eligible cached response can still be served if reachable.
- Provider dashboard alerts are additional visibility, not the application's sole spending enforcement.

Cost projections must remain viable for cold requests. Cache hits are a saving, not an assumption required for the budget to work.

## 12. User experience, descriptions and failure handling

The profile header shows the resolved institution, selected campus/city, official website and whether results were freshly retrieved or cached. The gallery displays all categories and required filters. Each card includes a publisher-page link, evidence status, score explanation and supported typed dates. Source links open the original publisher page rather than a search-results page.

Verified images are the default gallery. Uncertain material is separate and opt-in, with reasons; withheld/rejected images never fill an empty category. Coverage shows the number of base and total categories supported by verified photos. Do not average scores into an overall number that hides missing coverage.

Describe only supported campus facts, ideally in two to four short sentences. Each claim references evidence from the current permitted source set. A generic sentence about the institution's city is not enough to claim a complete campus description. If campus facts cannot be supported, omit the description and mark the profile partial.

| Situation | Required behavior |
| --- | --- |
| Ambiguous alias or multiple campuses | Return supported choices; do not generate a mixed profile |
| Unknown university | Request a fuller name/location and show no invented institution |
| Official site unavailable | Try attributable fallback sources within budget, keeping verification gates |
| Brave unavailable or credits exhausted | Try eligible cache/direct official retrieval from a supported identity; report gaps |
| OpenAI unavailable or output invalid | Use eligible prior assessments or conservative deterministic decisions that independently pass all gates; otherwise withhold |
| Few usable photos | Return fewer photos with category-specific evidence gaps |
| Blocked hotlinking, forbidden display or broken image at render time | Show publisher source plus explicit missing-image state; no proxy bypass; update visible coverage/completeness |
| Unsafe content or unresolved safety flag | Reject or withhold from all image galleries; never relax safe search |
| Deadline reached | Stop new work and finalize accepted material; distinguish partial from insufficient evidence |
| Budget or concurrency limit reached | Clear unavailable/busy state or eligible cache; no hidden paid bypass |
| Conflicting sources or models | Explain uncertainty; do not select the answer that produces more photos |

The AI-outage path does not grant automatic verification from an official URL. A new image must still meet the same scoring and provenance rules, or remain uncertain/withheld.

## 13. Security, operational evidence and reproducibility

Keep all provider keys in ignored local environment files and deployment secrets. Commit only variable names and setup instructions when implementation begins. No client-exposed secret variables, logged authorization headers or query-string keys.

The safe fetcher accepts only supported public HTTP(S) targets, validates DNS-resolved addresses and redirects, blocks private/loopback/link-local destinations and unsupported schemes, limits redirects/bytes/time, and sends no ambient user credentials. Bind outbound connections to validated destinations to address DNS rebinding. Apply the publisher-access policy and identifiable User-Agent from section 6. Parse retrieved HTML as data; never execute publisher scripts. The MVP exposes no arbitrary-URL image proxy, and no AI provider may bypass the safe fetcher by retrieving discovered URLs itself.

Bound text passed to AI and enforce schema validation and evidence-ID validation. Do not execute instructions found in captions or pages. Do not ask vision to identify individual students; the task concerns places and categories.

Retain permitted operational metrics: request IDs, stage durations, counts, provider/model IDs, cost estimates, cache class/hit status and normalized errors. Redact source payloads, model responses and URLs when their retention class forbids storage. Use aggregate rejection reasons for evaluation where raw examples cannot be retained.

Expose honest processing time and evidence dates. Record versions for scoring, extraction, prompts and models so a changed result can be explained. A demonstration cache, if used, must be automatically produced, permitted and disclosed; judges must also be able to run an unfamiliar university live.

## 14. Verification and acceptance before submission

No implementation or performance validation has occurred at spec time. The following are future acceptance checks, not claimed results.

### Deterministic and integration checks

- Entity normalization preserves relevant names; ambiguous abbreviations and distinct campuses are not collapsed.
- Domain validation rejects deceptive lookalike hosts and unsafe redirect/IP targets.
- Source association distinguishes a photo's own caption from unrelated page/footer text.
- Score examples and gates behave exactly as specified; missing provenance cannot be overcome by model certainty.
- Date extraction does not substitute crawl/retrieval time for publication or capture time.
- Duplicate checks cover identical, recompressed, resized and cropped images, plus similar buildings that must remain distinct.
- Provider failures, malformed model output, cancellation and deadline exhaustion yield documented terminal states.
- Concurrent spending reservations cannot exceed the configured allowance; timed-out calls are not automatically treated as free.
- Restricted responses are absent from persistent storage, framework caches, browser storage, logs and test fixtures.
- Every displayed image and descriptive claim links to its real supporting source.
- Primary, escalation and fallback AI adapters reject remote image URLs and receive only validated, bounded bytes; malformed media, oversized payloads and private-address redirects never reach them.
- Strict safe search is explicitly set on provider calls; unsafe or unrelated visuals and unresolved safety flags cannot appear in either image gallery.
- Robots/publisher prohibitions, access denials, pacing and crawler identity are respected without bypasses; access-policy lookups consume bounded request resources.
- Restricted images bypass persistent framework/proxy/service-worker caches. Permitted direct delivery works, while blocked or failed delivery produces the source-linked missing-image state and corrected coverage.
- Successive searches and multiple sessions on one shared IP work within the revised admission policy, while global concurrency and aggregate budgets remain enforced.
- The future selected streaming protocol handles framing, ordering, cancellation, malformed input and one terminal result without paid automatic replay.

### CI and release verification required in the implementation plan

The future implementation plan must include automated lint, TypeScript typecheck, relevant unit/integration tests, a production build and secret scanning. These are required checks for changes proposed for the release branch and must be rerun against the exact final release commit. Do not treat a passing development server or one successful build as proof that the other gates passed.

Secret scanning covers the working tree, tracked files and relevant Git history, plus generated client/build artifacts, with narrow documented exceptions for demonstrably non-secret fixtures. CI must not print detected secrets, embed credentials into artifacts or require production API keys for ordinary tests. Use mocks and rights-permitted fixtures for routine CI; run credentialed live acceptance checks separately with explicit spending limits.

Release evidence includes the passing check results and commit identifier, the early deployed-capability probe, and the cold/holdout/concurrency acceptance results below. A failed gate blocks release; fix and rerun the affected checks before submitting. This section specifies future plan requirements only: no CI workflow, test implementation, production build or live deployment is created or claimed during this spec update.

### Live evaluation

Use at least 10 institutions: seven Kazakhstan institutions, including at least two unfamiliar Kazakhstan institutions held out from prompt/threshold tuning, and at least three international institutions. Include ambiguous aliases, a multi-campus case and nonexistent input in additional scenarios. A holdout failure must remain visible rather than being replaced with a curated example.

Review at least 50 image decisions across accepted and rejected candidates, including stock, wrong-campus, visiting-event and duplicate cases. Store fixtures only when permitted. For transient Brave-derived examples, review during permitted use and retain aggregate counts rather than restricted source payloads.

Report verified-image precision, category correctness, duplicate escapes, category coverage, incomplete-result rate, cold and cached latency, and cost per request together. Internal release targets: at least 95% correct attribution and category assignment among sampled verified images, no known wrong-university or stock image in the verified release sample, and no surviving exact duplicate in the evaluation set. These small-sample targets are not population-level confidence claims.

Measure at least 20 cold generation runs, including holdouts, and a three-user concurrent scenario. Report median, p95 and maximum browser time alongside useful-result and complete-profile rates. A useful result for this evaluation includes at least three verified, distinct photos across at least two base categories, with at least one campus/facility image rather than city images alone, plus supported campus text. This internal threshold does not replace the full five-base-category case requirement or turn partial into complete.

Target p95 at most 30 seconds for useful results under ordinary test conditions, and report all failed/insufficient runs separately so a fast error cannot improve the success statistic. At least 80% of the resolved, sufficiently documented evaluation institutions should produce a useful result within the deadline; document how source availability was assessed before interpreting the outcome. If these targets fail, reduce work, improve evidence retrieval or disclose the limitation; never claim measured compliance prematurely.

Evaluate Luna and Terra on the same rights-permitted difficult examples before enabling escalation. Compare false verified results, category correctness, added latency and total cost. Enable escalation only if it fixes meaningful interpretation errors without introducing new false attribution in that sample and remains within the request deadline/budget. Model substitution never relaxes evidence gates.

## 15. Submission boundary and remaining validation

The official deadline is 19 September 2026 at 12:00 Astana time. The case requires a working deployed product, accessible GitHub repository with development history, README, demo video up to three minutes, PDF presentation up to eight slides, and technical disclosure (which may be included in README). The final main-branch version is fixed by the deadline; links must remain accessible without payment until results are announced. Submission is performed by the captain on aistartify.com with case code LOCUSCASE1. These are delivery requirements, not actions authorized by this specification-writing task.

The README must disclose the architecture, run instructions, test scenario, team roles, sources, AI/APIs, existing components and limitations, including cache restrictions, incomplete category coverage and measured timings. Manual evaluation is allowed and disclosed; manual selection must not supply hidden production results.

The remaining uncertainties are implementation measurements and account/source eligibility, not unspecified product behavior:

| Uncertainty | Resolution during implementation | Behavior if unresolved |
| --- | --- | --- |
| Model availability and actual rate limits | Check account capabilities and bounded live calls | Explicit unavailable/configured fallback; no silent substitution |
| Luna accuracy and value of Terra escalation | Reviewed evaluation described above | Escalation stays disabled; maintain uncertainty |
| Publisher image coverage and reuse basis | Inspect original-source evidence and applicable usage policy | Omit images/categories lacking a valid basis |
| Persistent storage eligibility | Record applicable provider/source permission | Transient-only; cold-budget assumptions remain valid |
| Hosting/free-tier capability, eligibility and continuity | Verify deployed Node/native processing/streaming/duration/memory/outbound concurrency early, plus account terms and availability through judging | Select a compatible host or adjust limits before building around it |
| 30-second useful-profile rate | Cold/holdout/concurrency measurements | Optimize bounded pipeline or report the limitation honestly |

The user has approved the written specification with the refinements recorded here and explicitly requested a stop after this update, self-review and presentation of changed sections. Do not create the implementation plan in this step. When planning is subsequently requested, it must choose SSE or streamed NDJSON and define the event schema, place deployed-capability verification early, and include the CI/release gates above. This document does not authorize production coding, purchases, account creation, publishing or deployment.

## 16. Reference sources

External documentation was checked during the design conversation on 2026-09-16. These references explain design inputs; the official case PDF remains the case-requirements authority. Confirm mutable prices, terms and account permissions again before integration.

- R1: [Brave Search API pricing](https://brave.com/search/api/).
- R2: [Brave Search API terms](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service).
- R3: [Brave help, credits and retention guidance](https://api-dashboard.search.brave.com/documentation/resources/help-feedback), [Image Search reference](https://api-dashboard.search.brave.com/api-reference/images/image_search), and [Web Search guidance](https://api-dashboard.search.brave.com/app/documentation/web-search).
- R4: [OpenAI GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and [image-input guidance](https://developers.openai.com/api/docs/guides/images-vision).
- R5: [OpenAI GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
- R6: [Wikidata data access](https://www.wikidata.org/wiki/Wikidata:Data_access), and [structured-data licensing](https://www.wikidata.org/wiki/Wikidata:Licensing).
- R7: [Vercel Hobby plan](https://vercel.com/docs/plans/hobby), and [function limits](https://vercel.com/docs/functions/limitations).
- R8: [Upstash Redis pricing](https://upstash.com/pricing/redis).
