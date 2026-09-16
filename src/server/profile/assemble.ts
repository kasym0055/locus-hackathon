import type { Category, Claim, FailureCode, ImageCardData, Profile, SourceRef, University } from "@/server/contracts";
export function assembleProfile(input: { university: University; cards: ImageCardData[]; description: Claim[]; sources: SourceRef[]; warnings: FailureCode[]; elapsedMs: number }): Profile {
  const categories: Category[] = ["campus", "dormitory", "classrooms", "library", "laboratories", "sport", "student_life", "city"];
  const covered = new Set(input.cards.filter(card => card.status === "verified" && card.delivery === "remote").map(card => card.category));
  const gaps = Object.fromEntries(categories.filter(category => !covered.has(category)).map(category => [category, "No verified photo available."]));
  return { ...input, sources: [...new Map(input.sources.map(source => [source.id, source])).values()], gaps,
    state: covered.size ? "partial" : "insufficient_evidence", verifiedBaseCategories: [...covered].filter(category => category !== "city").length, provenance: "live" };
}
