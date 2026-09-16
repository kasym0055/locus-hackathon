import { expect, it } from "vitest";
import { readPublisherPolicies } from "@/server/profile/services";
import { fixtureGrant } from "../support/profile-fixture";
it("defaults to no grants and scopes documented grants to one exact origin", () => {
  expect(readPublisherPolicies(undefined).size).toBe(0);
  const policies = readPublisherPolicies(JSON.stringify([fixtureGrant]));
  expect(policies.get("https://example.edu")?.display).toBe("direct_permitted");
  expect(policies.get("https://cdn.example.edu")).toBeUndefined();
});
it.each([
  { ...fixtureGrant, basis: [] }, { ...fixtureGrant, origin: "https://example.edu/path" },
  { ...fixtureGrant, locationSupported: true }, { ...fixtureGrant, origin: "http://example.edu" },
])("rejects invalid or evidence-granting configuration", grant => {
  expect(() => readPublisherPolicies(JSON.stringify([grant]))).toThrow();
});
it("ignores expired grants", () => {
  expect(readPublisherPolicies(JSON.stringify([{ ...fixtureGrant, expiresAt: "2020-01-01T00:00:00Z" }])).size).toBe(0);
});
