import { createHash } from "node:crypto";
import type { AssessmentInput, RunContext } from "@/server/contracts";
import type { Search } from "./search";

// Per-run transient text only. A matching parser source ID is required; an index
// result alone cannot authorize use after a publisher fetch/access-policy failure.
export function collectDiscoveryContext(search: Search) {
  const hints = new WeakMap<RunContext, Map<string, string>>();
  return {
    search: (async (input, ctx) => {
      const records = await search(input, ctx);
      const current = hints.get(ctx) ?? new Map<string, string>();
      hints.set(ctx, current);
      for (const record of records) {
        if (!record.snippet || record.policy.retention === "disallowed" || record.policy.display === "disallowed") continue;
        const id = createHash("sha256").update(record.pageUrl).digest("hex");
        if (current.size < 40 && !current.has(id)) current.set(id, record.snippet.slice(0, 600));
      }
      return records;
    }) satisfies Search,
    forEvidence(evidence: AssessmentInput["evidence"], ctx: RunContext): NonNullable<AssessmentInput["discoveryContext"]> {
      const result: NonNullable<AssessmentInput["discoveryContext"]> = [], seen = new Set<string>();
      for (const item of evidence) {
        const excerpt = hints.get(ctx)?.get(item.id);
        const key = `${item.id}:${item.imageId}`;
        if (excerpt && !seen.has(key)) { result.push({ evidenceId: item.id, imageId: item.imageId, excerpt }); seen.add(key); }
        if (result.length === 16) break;
      }
      return result;
    },
  };
}
