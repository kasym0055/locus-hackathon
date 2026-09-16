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
