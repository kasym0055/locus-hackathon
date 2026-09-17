# Tavily integration: normalization and Production handoff

## Data flow

SEARCH_PROVIDER selects exactly one adapter. Tavily Search finds page URLs, source-bound image URLs and snippets. Existing safe-fetch retrieves original pages under unchanged SSRF, robots, pacing and publisher budgets. The parser establishes the image caption, attribution/license and official corroboration. Prepared image bytes and publisher excerpts go to the existing OpenAI assessment. Search snippets travel separately as `untrustedDiscoveryContext`; the deterministic decision still uses original evidence and the existing score threshold.

The planner's licensed-category-first ordering is unchanged. This is not a crawl service or an alternative path around a blocked publisher. An indexed snippet cannot replace a denied page. Tavily Extract/Crawl and generated answers are not enabled. This integration does not implement Task 6.

## Normalization contract

| Provider field | Internal treatment |
| --- | --- |
| results[].url | Validate HTTP(S), reject embedded credentials/unapproved ports, normalize URL and remove fragment. Preserve query strings. Deduplicate by canonical page URL. Publisher fetch still validates DNS/IP/redirects. |
| results[].content | NFKC + whitespace normalization, at most 600 characters. Treat as provider hint, not original evidence. |
| results[].images[] | Accept URL strings and `{url}` objects. At most two unique images per page; no inferred binding by result rank/title. |
| top-level images | Ignore: no trustworthy source-page association supplied by that field. |
| answer / raw_content / provider score | Not requested or used as evidence, authority, license or verification score. |
| usage.credits | Settle reported integer credits; unexpected charge still accounted, then fail closed. If omitted on valid basic search, settle its documented one-credit cost. |

At most ten normalized records per search. Responses remain limited to 1MB by providerJson; malformed schema fails closed. Missing image URLs leave page records for the original parser. Metadata never grants third-party image display rights; the existing parser requires documented publisher permission and per-file Wikimedia licensing where applicable.

Request-local context retains at most forty source snippets; SHA256 page IDs must match actually collected parser evidence. At most sixteen hints go to OpenAI, each tied to an existing image/evidence pair. URLs are redacted from model text. Original corroboration excerpts are included once alongside primary excerpts (maximum 48). Provider hints introduce no new evidence IDs or independence points. No snippets, images or keys are persisted by the application or logged.

## Limits and cost

- Tavily uses `basic`, `safe_search=true`, `auto_parameters=false`, no generated answer, no raw content and no automatic retry.
- `fast`/`ultra-fast` cannot be used with safe_search per the [Search API documentation](https://docs.tavily.com/documentation/api-reference/endpoint/search).
- Maximum four Tavily calls / credits per profile, reserved atomically in a separate Redis aggregate. Unknown billed outcomes remain reserved. Missing confirmed allowance defaults to zero. Brave and OpenAI budgets are unchanged.
- Local operation timeout remains 3 seconds; profile deadline remains 27 seconds. HTML=12 and licensed-file reservation remain unchanged. No unbounded crawling.
- Tavily basic is documented as one credit per call: [credits](https://docs.tavily.com/documentation/api-credits). Runtime never enables automatic overage or upgrades search depth.

## Local evidence (2026-09-17)

Standalone initial basic search: NU returned five pages and five top-level images in 4574ms, one credit. This was not a LOCUS acceptance run. During adapter integration, four bounded provider probes were dispatched: a fast+safe_search combination failed; one basic response arrived HTTP 200 in 2151ms but exposed a schema mismatch; another hit the preserved 3s timeout; a final isolated contract probe returned HTTP 200 in 699ms, ten page records and one reported credit. It confirmed per-page string image arrays. The adapter now accepts that format under regression test. Provider costs for unsuccessful/timeout probes were not independently confirmed; do not count them as free. No publisher pages or image bytes were fetched by these standalone searches, and no real OpenAI call was made.

Synthetic integration tests exercise Tavily selection → publisher parser → image preparation → real OpenAI SDK with mocked provider response → deterministic verified card. This proves wiring, not live factual acceptance. Latency reliability and Production verified cards remain unproven.

## Operator configuration / promotion

Before selecting Tavily in Vercel Production:

1. Set `TAVILY_API_KEY` as a server secret. Prefer a replacement for the key shared in chat; never put it in source, logs or NEXT_PUBLIC variables.
2. Verify the account's remaining credits and overage settings. Set `TAVILY_VERIFIED_AVAILABLE_CREDITS` to an intentionally bounded allowance; do not invent an account balance. The Redis counter is cumulative: on later allowance changes include already recorded usage when computing the cumulative ceiling; redeployment does not reset spend. Do not delete counters to obtain more budget.
3. Set `SEARCH_PROVIDER=tavily`. Default remains brave until the operator changes it. No Brave key is required when Tavily is selected. Existing OpenAI, Redis, crawler contact and publisher policy configuration are still required.
4. Promote the committed deployment. Verify `x-locus-commit` before acceptance.
5. Run exactly one fresh NU Production request with Live Logs. Capture local-timeout/access-denied/budget-exhausted events and final stages. If NU verifies, test an unfamiliar university. Do not claim M1 closed until both pass; do not start Task 6.

Rollback: select `SEARCH_PROVIDER=brave` and redeploy. Existing Brave configuration and budgets apply. A Tavily key alone does not activate the adapter, grant publisher rights, or establish verified credit capacity.

## Verification of the integration commit

Focused: 82 tests passed. In an isolated worktree containing only this integration on ce91f5c: full suite 17 files / 352 passed / 8 skipped (Redis integration tests require REDIS_TEST_URL); typecheck passed; lint passed without warnings; production build passed; diff check passed. The pre-existing uncommitted safe-fetch changes in the shared working copy are excluded from this patch and its validation tree.
