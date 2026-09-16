# Hosted Node capability decision

The selected target is Vercel Functions using the Node.js runtime. The app pins Node to `24.x`, which Vercel documents as available for builds and functions and as the default for new projects. The capability route sets `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `maxDuration = 60`.

Vercel documents a 300-second default and maximum duration on Hobby with Fluid compute, and a Standard function instance at 2 GB. Those published limits are sufficient for the route's 28-second stream, subject to the selected account's current plan and usage. Vercel's pricing material says function invocations and duration are priced/usage-tracked; the actual account plan, remaining allowance, and any overage setting must be checked after authenticated deployment.

## Capability probe

`GET /api/capability` is disabled by default. To run it, deploy with `CAPABILITY_PROBE_ENABLED=true`, a non-empty `CAPABILITY_PROBE_TOKEN`, and, if network probing is needed, a project-owned `CAPABILITY_PROBE_ENDPOINT`. The route accepts no URL input from a request. It streams NDJSON frames numbered 0, 1, and 28; builds a self-authored 5,000 × 4,000 raster; performs no more than two simultaneous Sharp decodes; hashes the decoded output; reports RSS; and cancels its timing waits when the client disconnects.

Run the production probe only after setting `DEPLOYMENT_URL` and `CAPABILITY_PROBE_TOKEN` in the execution environment:

```powershell
pnpm probe:host -- --url $env:DEPLOYMENT_URL
```

The script first cancels a request after the streamed start frame, then makes three concurrent requests. It requires each to reach frame 28, confirms the 20-megapixel source and two-decode ceiling, reports peak RSS, and fails if a reported memory limit leaves less than 25% headroom.

Local exercise on 2026-09-16: the script received cancellation frame 0, completed all three concurrent requests through frame 28, processed 20,000,000 source pixels with two decodes per request, and observed 607,973,376 bytes peak RSS. The local Node runtime reported no constrained-memory limit (`0`), so it could not calculate local headroom. This verifies the route behavior locally only; it is not host-capability evidence.

## External deployment blocker — 2026-09-16

No authenticated eligible Node host is available on this machine. Safe checks found no Vercel CLI, `VERCEL_TOKEN`, Vercel project/team variables, or `C:\Users\user\.vercel\auth.json`; the corresponding Netlify and Cloudflare token/config checks were also absent. No account was created and no deploy command was issued. Consequently there is no deployment URL, plan/credit observation, or production probe evidence for this task.

Sources: [Node 24 availability](https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions), [function limits](https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute), and [usage pricing guidance](https://examples.vercel.com/docs/pricing/manage-and-optimize-usage).
