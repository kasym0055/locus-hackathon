import type { UsagePolicy } from "@/server/contracts";
export function documentedPolicyFor(url: string, policies?: ReadonlyMap<string, UsagePolicy>): UsagePolicy | undefined {
  const origin = new URL(url).origin;
  const grant = policies?.get(origin);
  return grant?.origin === origin && grant.basis.some(basis => basis.trim())
    && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) ? grant : undefined;
}
export function mergePolicy(a: UsagePolicy, b: UsagePolicy): UsagePolicy {
  const rank = { cache_permitted: 0, transient_only: 1, disallowed: 2 };
  const retention = rank[a.retention] >= rank[b.retention] ? a.retention : b.retention;
  const display = a.display === "disallowed" || b.display === "disallowed"
    ? "disallowed" : a.display === "direct_permitted" && b.display === "direct_permitted"
    ? "direct_permitted" : "link_only";
  const expiry = [a.expiresAt, b.expiresAt].filter((x): x is string => Boolean(x)).sort()[0];
  return { retention, display, origin: `${a.origin}+${b.origin}`,
    policyVersion: "v1", basis: [...a.basis, ...b.basis], expiresAt: expiry,
    attributionText: [a.attributionText, b.attributionText].filter(Boolean).join("; ") || undefined };
}
