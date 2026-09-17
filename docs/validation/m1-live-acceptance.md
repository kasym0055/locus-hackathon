# M1 live acceptance — 2026-09-17

M1 remains open. Task 6 has not started.

## Deployment and initial state

The feature worktree and remote `feat/m1-vertical-slice` both pointed to
`e75baa8eef521ad1511b5252d2bdb56d7f9c7a67`, with a clean working tree before this
investigation. The recent history contains the resolver, Wikimedia permission,
corroboration, shared-fetch-budget and identity-page-priority fixes. None was
reimplemented here.

GitHub's Vercel integration records successful **Production** deployment
`6497040229` of that exact SHA at `2026-09-17T06:34:52Z`. The public Production
origin returned HTTP 200 and Next build ID `m25rQlWYicmeUmAj0kptx`.
The immutable deployment URL redirects to Vercel authentication, and its
dashboard also requires login. Thus the successful Production deployment
record is verified, but a direct comparison between the public alias and the
immutable deployment's build identity was unavailable. The old application
does not expose a commit header.

## One bounded NU request

At approximately `2026-09-17T06:43:21Z`, a fresh ordinary session submitted one
`POST /api/profile` to `https://locus-hackathon-virid.vercel.app`, with
`query="Nazarbayev University"` and `countryHint="Kazakhstan"`. There were no
retries, cache bypasses, transport substitutions or setting changes. The client
timeout was 35 seconds; the application retained its 27-second deadline and
existing admission/provider budgets. Cookies and publisher/source payloads were
not retained. A count/timing/state summary is in the ignored local
`tmp-live-artifacts/nu-e75baa8-summary.json`.

Request ID: `e3b41a88-a744-4c6c-915d-43efb7dd2086`.

| Sequence | Client arrival | Event |
| --- | ---: | --- |
| 1 | 1,190 ms | `resolving` |
| 2 | 4,786 ms | Identity resolved: Nazarbayev University, Astana, Kazakhstan |
| 3 | 4,793 ms | `discovering` |
| 4 | 9,148 ms | Warning: `budget_exhausted` |
| 5 | 9,157 ms | Final: `insufficient_evidence`; same warning |

HTTP 200; normal EOF at 9,260 ms. Server final elapsed time: 8,185 ms.
The exact stopping stage is **discovery**. No `preparing`, `assessing`,
`assembling` or `image` event occurred. The runner therefore did not call image
preparation or OpenAI on this request, and no verified card was produced.
Actual Brave/ledger totals were not visible in the response and are not claimed.
The unfamiliar-university test remains pending the NU gate.

## Root-cause evidence still needed

`budget_exhausted` alone cannot identify a counter: safe-fetch has an eight-HTML
attempt cap shared by resolution and discovery, a 24-image-attempt cap, and an
eight-origin policy cap. HTML redirects consume HTML attempts; robots consume
policy-origin slots but not HTML attempts. Provider budgets also use the same
failure code. An elapsed time below 27 seconds does not establish which counter
failed.

There was no publisher dispatch trace in the deployed code. The **live exact
publisher sequence/count is not yet known**; no inferred list of URLs or counts
is presented as an observation. The shared cap is a hypothesis, not a completed
root-cause finding. No discovery behavior or budget is changed by this patch.

## Diagnostic-only change

On the first internal publisher budget rejection in a request, the default
fetcher emits one server log record with `event="publisher_budget_exhausted"`:

- `requestId`, `exhausted` (`html_attempts`, `image_attempts`, or `policy_origins`),
  and the unchanged `limit`;
- exact dispatch counts separated into HTML, image and robots;
- up to 64 actual dispatch records in dispatch order, with operation phase,
  redirect hop, request-local target/origin IDs, elapsed start time, and observed
  response status, failure and duration when available;
- the rejected target ID, phase and hop, kept separate from dispatched attempts.

Repeated targets have the same numeric ID within that request only. Raw URLs,
query strings, hostnames, page bodies, images, evidence excerpts, provider output
and credentials do not enter this record. URL-to-ID maps remain request-local.
An attempt still in flight when the first rejection occurs can lack its final
status/duration. No attempt is retried for diagnostics, and a failing log sink
cannot alter budget enforcement. No diagnostic data enters the public stream.

Internal phase labels distinguish identity, official discovery, licensed
category/file inspection, official corroboration, image-search page inspection,
and image preparation. These labels do not alter ordering or eligibility.

`POST /api/profile` also includes `x-locus-commit` when Vercel supplies a valid
40-character Git SHA. It is available even on a request rejected before
admission, so the deployed commit can be checked without provider spending.
It is omitted when the host does not supply a valid SHA.

## Verification

TDD reproduction: before the implementation, the two transport diagnostic tests
failed because no budget report was emitted. The commit-header regression failed
because its response header was absent. They pass after the instrumentation.
The transport tests use a real local socket fixture and unchanged public-IP
screening/pinning code; external responses are synthetic.

The dispatch regression observes one robots request followed by eight HTML
dispatches across two phases and repeated three-hop chains. It identifies the
blocked ninth HTML attempt at redirect hop 2 and does not dispatch it. A separate
test distinguishes exhaustion of eight policy origins from HTML exhaustion.
These are **fixture results**, not the missing live NU sequence.

- `pnpm test`: 308 passed; eight existing real-Redis tests remain service-gated.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.

Independent review found a diagnostic target-ID mismatch for rejected fragment
URLs. A new regression reproduced it, and the report now uses the same normalized
HTTP URL as transport. One subsequent full-suite run suffered a Windows worker
exit (`3221226505`) while running safe-fetch; all 65 safe-fetch tests passed in
isolation, followed by a clean full-suite rerun with the results above. The native
worker exit was not reproduced or attributed to an application defect.

All publisher/license gates, SSRF screening, safe-fetch rules, deterministic
verified threshold, Brave/OpenAI budgets, and the 27-second work deadline remain
unchanged.

## Resume after operator promotion

Promote the diagnostic commit from `feat/m1-vertical-slice` to Production and
provide an authenticated Vercel dashboard session for reading its runtime logs.
No env, secret, billing or permission expansion is requested by this patch.

Then verify `x-locus-commit` on a rejected pre-admission request, make one bounded
NU request, and match its request ID to the server diagnostic record. Report the
exact dispatch sequence and exhausted counter before choosing a fix.

If that trace shows that necessary generic identity, licensed-source and
independent-corroboration retrieval cannot fit eight raw HTML attempts, the next
proposal should define explicit phase reservations and one bounded total attempt
allowance, sized from the observed sequence and its redirect costs. It must keep
all the listed safeguards and deadline/provider budgets. Another page-specific
workaround is not an acceptable next step.

Only after a real NU OpenAI assessment and verified card should the unfamiliar
university be attempted. M1 must not be closed, and Task 6 must not start, on the
basis of local fixtures or this diagnostic deployment.

## Definitive publisher-budget trace and bounded correction

After Production was promoted to diagnostic commit
`ac341bdb203b2e8c7c69a3c6bf02854bd4f1a125`, `x-locus-commit` returned that exact
SHA. One NU request (`e9cc6a25-7972-43b8-937b-e95994b4e232`) again stopped in
discovery with `budget_exhausted`, after 6,765 ms of server time. Its matching
Vercel event established the exact counter and sequence:

- `exhausted=html_attempts`, `limit=8`;
- dispatched: eight HTML, zero image, four robots requests;
- HTML phases: two identity, one licensed category, then five licensed files;
- the next licensed-file HTML attempt was blocked;
- image preparation and OpenAI were not reached.

This closes the root-cause investigation: eight raw HTML dispatches cannot fit
the legitimate generic chain that Production actually followed. The bounded
architectural correction raises the per-profile HTML limit to 12. Licensed-file
inspection has a separate ceiling of ten HTML dispatches, reserving attempts 11
and 12 for immediate official corroboration and its possible redirect/final
fetch. Image and policy-origin limits remain 24 and eight respectively.

Socket-backed regressions reproduce two identity pages, one Commons category,
five nonqualifying Commons files, a sixth object-specific licensed file, and
immediate official corroboration. The planner returns that first corroborated
candidate without fetching the seventh file. Separate transport tests prove a
licensed file cannot consume attempts 11 or 12, corroboration can use both, and
attempt 13 is rejected before dispatch with `budget_exhausted`. The existing
eight-page planner visitation bound and eight-file shortlist remain unchanged.

Focused safe-fetch, discovery and profile-route verification passed 136 tests.
The complete suite passed 311 tests with eight existing real-Redis tests skipped
under `--maxWorkers=1`; typecheck, lint and the production build also passed. A
prior default-concurrency suite run ended in the known intermittent Windows
worker fast-fail (`0xC0000409`) without an assertion. The affected 51-test file
passed alone, and the complete bounded-worker rerun passed, so no application or
runner configuration was changed for that environmental failure.

## Access-denial diagnostic handoff (2026-09-17)

Production commit `746bee92b21aa7d0234e8c4c1ccad05ff7e926d5` was verified by
`x-locus-commit`. Exactly one fresh NU profile request,
`95435d96-8299-451f-93a9-4a5dafa2bcc1`, returned HTTP 200 and a terminal
`insufficient_evidence` result with `access_denied` during discovery. Server
latency was 9,359 ms (9,818 ms client latency). Neither preparation nor assessment
was reached: zero OpenAI calls, zero OpenAI spend, and no card. The response had
no publisher-budget warning. Its runtime logs expired before retrieval, so the
precise denied fetch remains unknown. The HTML-budget incident has not met its
live closure criterion of preparation plus a real OpenAI call.

The diagnostic-only follow-up emits `publisher_access_denied` from existing
safe-fetch denial branches. Each request can emit at most 16 reports. The sink
receives only request ID, phase, fetch kind, redirect hop, request-local numeric
origin/target IDs, denial category, HTTP status when available at the rejection
point, retry-time presence and bounded relative milliseconds, and elapsed time.
Retry duration is clamped to zero through 24 hours; no absolute retry timestamp
is logged. No URL, hostname, query, publisher content, credentials, image bytes,
or personal data enters the log payload.

Access-denial IDs describe only denied targets and are independent of the
existing budget-event IDs. Both ID maps and report count are request-local and
bounded to 16. A robots transport rejection and the consequent content denial
can emit separate records. A direct `checkAccess` call is marked `kind=robots`
because it checks policy without dispatching content; its target ID identifies
the checked URL. A policy rejection before content dispatch has no content HTTP
status. `preflight_policy` includes configured publisher prohibitions and cached
origin backoff; `robots_policy` covers the access-policy gate. Other categories
are `crawl_pacing`, `retry_after`, `http_status`, `x_robots_tag`, and `meta_robots`.

Diagnostics are never awaited. Synchronous sink exceptions and asynchronous
rejections are contained, preserving the original transport failure and cleanup.
Socket-backed tests cover every required denial category, redirect hops, repeated
target IDs, report bounds, failing sinks, direct policy checks, and coexistence
with the unchanged twelve-HTML-dispatch ceiling and rejection of attempt 13.
The full suite passed 322 tests with eight existing Redis-dependent tests skipped
under `--maxWorkers=1`; typecheck, lint, and the production build passed.

No access decision, robots rule, fetch order, fetch/provider budget, license
policy, SSRF protection, image behavior, deterministic verification rule, or
27-second deadline was changed. No new NU Production request was issued for this
patch. After pushing, stop for operator Production promotion. Only after the
diagnostic commit is Production may the next single NU acceptance request run;
capture its matching events before the Hobby log-retention window expires.
M1 remains open. Task 6 must not start.

## Bounded official corroboration fallback (2026-09-17)

The operator supplied a Production `publisher_access_denied` event for request
`7ccb1755-40cb-45cc-a36a-4d38841e5433`: phase `official_corroboration`, kind `html`,
hop zero, source `robots_policy`, no retry time, elapsed 5,998 ms. This identifies
the access-policy gate on the first corroboration target, not publisher-budget
exhaustion. It does not establish which underlying robots condition denied access.

The planner now considers at most two distinct unvisited official page candidates
per object, in search-result order, using the same search query and safe-fetch
path. Non-official results do not consume those two slots. A denied page or a
page without object support can fall through to the next candidate. Valid
independent corroboration stops the loop immediately. Request-local object
tracking prevents another licensed file for the same object from restarting its
search or two-candidate allowance. Exhausting that allowance grants no evidence.

Only planner selection changes. The eight-page visitation bound, twelve raw HTML
dispatch limit, licensed-file ceiling and corroboration reservation, redirect
enforcement, robots/access policy, SSRF, provider budgets, 27-second deadline,
publisher/license rules, and deterministic verification remain unchanged.

Synthetic socket-backed regressions exercise a real robots denial followed by
permitted corroboration, irrelevant-first fallback, both-denied and both-irrelevant
results, immediate first-source success, skipped external/lookalike domains, and
no third official candidate even across repeated files for the same object. One
case consumes all twelve permitted HTML dispatches and rejects attempt 13.

Verification: 152 focused tests passed; the full suite passed 327 tests with eight
existing Redis-dependent tests skipped. Typecheck, lint, production build, and
diff checks passed. The first full-suite run hit the previously observed Windows
worker exit `3221226505` in profile-route without an assertion failure; a complete
rerun passed. No runner or application setting was changed to obtain that pass.

After this commit is pushed, stop for Production promotion. No NU request was
issued while implementing this change. After promotion, verify `x-locus-commit`,
run exactly one fresh NU request, and capture the matching runtime logs promptly.
Both incidents can close only when the live request reaches preparing, assessing,
and a real OpenAI call. Later-stage failures must be investigated separately.
M1 remains open; Task 6 must not start.

## Official-origin diversity follow-up (2026-09-17)

The operator supplied two `publisher_access_denied` events for Production request
`fc011b6d-b86b-4a42-82ab-9dd857ca9cfc`. Both were HTML `robots_policy` denials in
`official_corroboration`, with origin ID 1 and target IDs 1 and 2. The bounded
two-page fallback ran, but both candidates came from the same origin. This is
not evidence of HTML-budget exhaustion or an origin-wide robots prohibition.

The planner now orders already-validated official search results in two passes:
the first unvisited candidate from each origin, then a second candidate from each
origin. Search ranking is preserved within each pass. Duplicate targets are
removed. At most three candidates per object and two per origin can be inspected;
valid corroboration ends inspection immediately. Existing per-object tracking
prevents a later licensed file from restarting the allowance. Same-origin paths
remain eligible, with each access decision delegated to the existing safe fetcher.

Only planner ordering changes. All transport, robots, SSRF, publisher/license,
deadline, provider-budget and deterministic verification rules remain unchanged,
including the 12-HTML limit, licensed-file ceiling/reservation, image and
policy-origin limits, and eight-page planner visitation bound. Socket-backed
regressions cover origin diversity, first-source success, path-specific denial,
all three candidates denied without a fourth attempt, malicious lookalike domains,
the two-per-origin bound, and rejecting HTML attempt 13.

Verification passed: 26 focused discovery tests, 78 isolated safe-fetch tests,
typecheck, lint, production build and diff checks. Full verification via
`node node_modules/vitest/vitest.mjs run --maxWorkers=1` on system Node 24.15.0
passed all 15 files: 330 tests passed and eight existing Redis-dependent tests
were skipped. Earlier invocations through bundled Node 24.19.0 hit the previously
observed Windows native worker exits in safe-fetch/profile-route; a threads-pool
attempt also exited unsuccessfully. No application or runner configuration was
changed, and no assertion was relaxed to obtain the complete passing run.

Stop after push for operator Production promotion. No new NU request was issued
for this patch. After promotion, verify the deployed commit, run exactly one NU
request, and promptly capture its stages, latency, warnings, denial/budget events,
OpenAI call count and final status. Discovery/corroboration remains open until
preparation, assessment and a real OpenAI call are confirmed. Task 6 must not start.
