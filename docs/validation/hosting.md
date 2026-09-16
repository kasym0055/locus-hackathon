# Hosted Node capability decision

The selected target is Vercel Functions using the Node.js runtime. The app pins Node to `24.x`, which Vercel documents as available for builds and functions and as the default for new projects. The capability route sets `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `maxDuration = 60`.

Vercel documents a 300-second default and maximum duration on Hobby with Fluid compute, and a Standard function instance at 2 GB. Those published limits are sufficient for the route's 28-second stream, subject to the selected account's current plan and usage. Vercel's pricing material says function invocations and duration are priced/usage-tracked; the actual account plan, remaining allowance, and any overage setting must be checked after authenticated deployment.

## Capability probe

`GET /api/capability` is disabled by default. A full probe requires `CAPABILITY_PROBE_ENABLED=true`, a non-empty `CAPABILITY_PROBE_TOKEN`, and a project-owned `CAPABILITY_PROBE_ENDPOINT`; there is no request-controlled URL. It streams NDJSON frames numbered 0, 1, and 28, with client-side arrival timestamps recorded by the probe. The route builds a self-authored 5,000 × 4,000 raster, samples RSS before, during, and after native work, performs no more than two simultaneous Sharp decodes, hashes decoded output, and reports each instance's memory limit.

The probe makes one cancelled client stream request with a generated run ID and polls its token-protected cancellation status. The route owns an internal `AbortController`; both request and stream cancellation trigger it, and its timing waits and outbound HEAD fetches share the signal. The server record reports cleanup and aborted outbound work. Full runs require six actually-dispatched successful outbound requests, measured active-request counts, and a maximum of two requests to the configured origin. A reported host memory limit is mandatory before the script can report a 25% headroom pass. `--allow-unknown-memory` is only for a local mechanics exercise and produces `inconclusive`, never `pass`.

Run the production probe only after setting `DEPLOYMENT_URL` and `CAPABILITY_PROBE_TOKEN` in the execution environment:

```powershell
pnpm probe:host -- --url $env:DEPLOYMENT_URL
```

The script first cancels a request after the streamed start frame, obtains its server cancellation status, then makes three concurrent requests. It requires an early first client arrival, a distinct final arrival after 27 seconds, the 20-megapixel source and two-decode ceiling, configured outbound attempts/successes/concurrency, and per-instance memory headroom of at least 25%.

Local exercise on 2026-09-16: the revised script recorded client first arrivals of 58/137/262 ms and final arrivals of 28,049/28,125/28,221 ms; the server cancellation record confirmed request-abort cleanup and outbound abort; and it observed 600,117,248 bytes peak RSS. Local Node reported a constrained-memory limit of `0` for every instance, so the explicit `--allow-unknown-memory` mode returned `inconclusive`. This verifies route mechanics locally only; it is not host-capability evidence.

## External deployment blocker — 2026-09-16

No authenticated eligible Node host is available on this machine. Safe checks found no Vercel CLI, `VERCEL_TOKEN`, Vercel project/team variables, or `C:\Users\user\.vercel\auth.json`; the corresponding Netlify and Cloudflare token/config checks were also absent. No account was created and no deploy command was issued. Consequently there is no deployment URL, plan/credit observation, or production probe evidence for this task.

Sources: [Node 24 availability](https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions), [function limits](https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute), and [usage pricing guidance](https://examples.vercel.com/docs/pricing/manage-and-optimize-usage).

CI is deliberately not present in this Task 1 slice. The approved plan assigns the workflow, frozen installation, host-tested Node execution, and release verification to Task 10; the `engines.node` pin remains `24.x` for that later workflow.

## Task 2 publisher transport validation — 2026-09-16

Publisher retrieval now uses Undici with all DNS answers screened by parsed address ranges, an explicitly pinned numeric socket destination, the original Host/TLS server name, and TLS certificate verification enabled. Redirects are followed manually only after a fresh destination and access check, up to three redirects. Each invocation combines caller cancellation with at most three seconds of remaining request time. All publisher/robots/image requests share a process-wide ceiling of six outbound requests and two per hostname; crawl pacing can make that ceiling lower. Per-run publisher attempts (including redirects) stop at eight, image attempts at 24, and origin policy checks at eight.

Streaming wire and decoded-body guards cap HTML at 2,000,000 bytes, raster inputs at 5,000,000 bytes, and robots at 512,000 bytes. Only one supported content coding is accepted. Undici `request` has no automatic redirect interceptor. Its [documented request/dispatcher APIs](https://undici.nodejs.org/) and the installed connector implementation were checked for socket pinning and TLS behavior.

`CRAWLER_CONTACT_URL` must contain an operator-confirmed real project/contact HTTPS URL. Missing or placeholder contact configuration disables crawling. No real contact URL was invented or configured in this task. The default source policy remains `transient_only` and `link_only`; public availability or a citation does not establish permission. Trusted server composition may supply documented origin-specific publisher permissions to candidate extraction, and must retain stricter discovery restrictions and attribution obligations. Publisher terms prohibitions can be supplied through the fetcher's server-only construction options; these options are not request-controlled and no proxy route was added.

Deterministic tests use self-authored synthetic HTML and a local socket fixture. The fixture maps only the transport's already-validated destination to a local test server; production has no destination-validation bypass. Tests cover forbidden IP ranges, mixed DNS, rebinding, redirect validation, byte/timeout/cancellation cleanup, robots and publisher restrictions, Retry-After, crawl pacing, and independent retention/display decisions. These tests prove local mechanics, not a live publisher's permissions or hosted execution.

The deployed native/network check was attempted again with `pnpm probe:host`. It stopped before any network request with `DEPLOYMENT_URL/--url and CAPABILITY_PROBE_TOKEN are required`. The authenticated deployment blocker above remains open. No hosted proof, eligible plan/credits, or live publisher crawl is claimed; the full hosted probe and real permitted publisher check remain required after authenticated deployment and real crawler identity configuration.
