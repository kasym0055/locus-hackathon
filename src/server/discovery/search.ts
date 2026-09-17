import type { RunContext, UsagePolicy } from "@/server/contracts";

export interface SearchInput { query: string; kind: "web" | "images" }
export interface DiscoveryRecord {
  pageUrl: string; imageUrl?: string; policy: UsagePolicy;
  // Provider text is a hint, never original-publisher evidence or a license.
  snippet?: string;
}
export type Search = (input: SearchInput, ctx: RunContext) => Promise<DiscoveryRecord[]>;
