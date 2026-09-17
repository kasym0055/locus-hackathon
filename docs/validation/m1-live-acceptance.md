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
