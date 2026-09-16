import type { Ledger } from "@/server/usage/ledger";

export class LeaseReleaseFailure extends Error {
  readonly code = "dependency_unavailable";
  constructor() { super("Admission lease release did not complete"); this.name = "LeaseReleaseFailure"; }
}

// Cleanup is independent of the cancelled/27-second work signal. Production
// Redis transport already times out at 2s; this outer bound also covers adapters.
export async function releaseLease(ledger: Ledger, requestId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => ledger.release(requestId)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LeaseReleaseFailure()), 3_000); }),
    ]);
  } catch { throw new LeaseReleaseFailure(); }
  finally { clearTimeout(timer); }
}
