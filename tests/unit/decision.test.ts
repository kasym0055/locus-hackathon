import { expect, it } from "vitest";
import { decide } from "@/server/policy/decide";
import { decisionFixture } from "../support/fixtures";

const strong = () => decisionFixture({ authority: "official", association: "explicit", corroboration: 20, visual: 10 });
it.each([
  ["official", "mention", 0, 5, 40, "withheld"],
  ["official", "explicit", 0, 10, 80, "verified"],
  ["attributable", "explicit", 0, 10, 70, "uncertain"],
  ["attributable", "explicit", 20, 10, 90, "verified"],
] as const)("scores %s/%s from evidence", (authority, association, corroboration, visual, score, status) => {
  expect(decide(decisionFixture({ authority, association, corroboration, visual }))).toMatchObject({ score, status });
});
it("rejects a university visit to another campus despite official provenance", () => {
  const input = strong(); input.evidence.conflict = true;
  expect(decide(input)).toMatchObject({ status: "rejected", score: 0 });
});
it("withholds fake assessment evidence IDs", () => {
  const input = strong(); input.assessment.evidenceIds = ["invented-source"];
  expect(decide(input).status).toBe("withheld");
});
it.each(["same-id", "same-caption", "same-publisher", "syndicated", "unknown-id", "wrong-image"])("does not award corroboration for %s", (kind) => {
  const input = decisionFixture({ authority: "attributable", association: "explicit", corroboration: 20, visual: 10 });
  const support = input.evidence.corroborationSources![0];
  if (kind === "same-id") { support.source.id = input.evidence.source.id; input.evidence.corroborationEvidenceIds = [support.source.id]; }
  if (kind === "same-caption") support.excerpt = input.evidence.excerpt;
  if (kind === "same-publisher") support.source.url = "https://example.edu/another";
  if (kind === "syndicated") support.independent = false;
  if (kind === "unknown-id") input.evidence.corroborationEvidenceIds = ["invented"];
  if (kind === "wrong-image") support.imageId = "different-image";
  expect(decide(input)).toMatchObject({ status: "uncertain", score: 70, components: { corroboration: 0 } });
});
it("caps link-only display below verification", () => {
  const input = strong(); input.evidence.source.policy.display = "link_only";
  expect(decide(input)).toMatchObject({ status: "uncertain", score: 79 });
});
it.each(["safety", "relevance", "assessed"] as const)("withholds unresolved %s", (flag) => {
  const input = strong();
  if (flag === "safety") input.assessment.safety = "uncertain";
  if (flag === "relevance") input.assessment.relevance = "uncertain";
  if (flag === "assessed") input.assessment.assessed = false;
  expect(decide(input).status).toBe("withheld");
});
it.each(["stock", "render"] as const)("rejects %s", (kind) => {
  const input = strong(); input.assessment.authenticity = kind;
  expect(decide(input).status).toBe("rejected");
});
it("AI certainty cannot override weak evidence", () => {
  const input = decisionFixture({ authority: "official", association: "mention", corroboration: 0, visual: 5 });
  Object.assign(input.assessment, { confidence: 100 });
  expect(decide(input)).toMatchObject({ score: 40, status: "withheld" });
});
it.each(["resolved", "usable", "location", "category", "contradiction", "provenance"])("caps missing %s gate", (gate) => {
  const input = strong();
  if (gate === "resolved") input.resolved = false;
  if (gate === "usable") input.usable = false;
  if (gate === "location") input.evidence.locationSupported = false;
  if (gate === "category") input.evidence.categorySupported = false;
  if (gate === "contradiction") input.assessment.location = "uncertain";
  if (gate === "provenance") { input.evidence.officialDirect = false; input.evidence.independentEquivalent = false; }
  expect(decide(input)).toMatchObject({ score: 79, status: "uncertain" });
  expect(decide(input).reasons.length).toBeGreaterThan(0);
});
it("city membership verifies only a city image", () => {
  const input = strong(); input.evidence.locationScope = "city";
  expect(decide(input).score).toBe(79);
  input.assessment.category = "city";
  expect(decide(input)).toMatchObject({ score: 100, status: "verified" });
});
it("requires an observed distinctive identifier for ten-point corroboration", () => {
  const input = decisionFixture({ authority: "attributable", association: "explicit", corroboration: 10, visual: 10 });
  expect(decide(input).components.corroboration).toBe(0);
  input.evidence.corroborationSources![0].visibleIdentifier = "Library Hall 1932";
  input.evidence.corroborationSources![0].excerpt = "Library Hall 1932 is the selected campus library building.";
  input.assessment.observations.push("The entrance is marked Library Hall 1932.");
  expect(decide(input)).toMatchObject({ score: 79, status: "uncertain", components: { corroboration: 10 } });
});
it.each(["unsafe", "irrelevant", "forbidden", "disallowed", "wrong-image", "missing-source", "no-observation"])("keeps %s out of verified output", (kind) => {
  const input = strong();
  if (kind === "unsafe") input.assessment.safety = "unsafe";
  if (kind === "irrelevant") input.assessment.relevance = "irrelevant";
  if (kind === "forbidden") input.evidence.forbidden = true;
  if (kind === "disallowed") input.evidence.source.policy.display = "disallowed";
  if (kind === "wrong-image") input.assessment.imageId = "different-image";
  if (kind === "missing-source") input.evidence.source.url = "";
  if (kind === "no-observation") { input.assessment.observations = []; input.evidence.corroboration = 0; }
  const result = decide(input);
  if (["unsafe", "irrelevant", "forbidden", "disallowed"].includes(kind)) expect(result.status).toBe("rejected");
  else expect(result.status).not.toBe("verified");
  if (kind === "no-observation") expect(result.components.visual).toBe(0);
});
