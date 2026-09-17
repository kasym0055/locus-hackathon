# Tavily discovery and assessment context

User approved implementation of Tavily + existing parser + OpenAI, with implementation choices delegated. This is an architectural extension of the existing search interface and shared cost ledger, not Task 6.

## Design

Select one search provider with SEARCH_PROVIDER=brave|tavily (default brave for safe deployment). No automatic cross-provider fallback. Tavily uses fixed-endpoint REST Search, basic depth, safe_search, no generated answer or raw content, no retries. Keep the existing 3-second operation timeout and 27-second profile deadline. The standalone basic probe took 4574ms / 1 credit; it does not establish adapter latency or live acceptance.

Normalize page URLs, per-page image URLs and bounded text snippets. Drop malformed URLs, duplicates and unbound top-level images; never invent an image-to-page association or infer a license from search descriptions. Preserve query parameters; strip fragments only. Publisher URLs still pass existing safe-fetch and access policy. Search policy remains transient/link-only; only the existing parser policy rules can establish a documented publisher display grant; disallows and retention restrictions remain binding.

Keep planner ordering and all publisher limits unchanged. Tavily replaces search at current integration points, not publisher parsing. Request-local snippets are joined only to original-publisher evidence actually collected by the parser. Pass them separately as untrusted discovery context to OpenAI, bound to existing evidence/image IDs. Include original corroborating excerpts in assessment input. Hints are not independent evidence, licensing grants, or deterministic score inputs. Preserve original model budgets, strict output parsing, and verified threshold.

Account Tavily separately in the existing atomic ledger: maximum four one-credit searches per profile; operator-specified verified credit allowance defaults to zero. Unknown billed outcomes retain reservations; no automatic refunds or unlimited paid overage. Brave and AI limits stay unchanged.

## Acceptance and deployment

Test normalization, request-local isolation, absence of fabricated source bindings, provider cancellation/timeouts, four-call ceiling, fifth-call rejection, conservative billing, and separate model context. Verify focused/full tests, typecheck, lint, production build and diff check. Do not include pre-existing safe-fetch edits in this commit. Add deployment/normalization documentation. Production needs operator-provided SEARCH_PROVIDER, TAVILY_API_KEY and verified Tavily credits; stop for promotion. No new Production NU request before promotion. No claim of live verified card from mocked tests or standalone search probes.
