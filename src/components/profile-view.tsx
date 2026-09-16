"use client";
import { useState } from "react";
import type { Profile } from "@/server/contracts";
import { ImageCard } from "./image-card";
export function ProfileView({ profile }: { profile: Profile }): React.JSX.Element {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  return <section aria-label="University profile">
    <h2>{profile.university.name}</h2>
    <p>{profile.university.campus} · {profile.university.city} · {profile.university.country}</p>
    {profile.cards.map(card => <ImageCard key={card.id} card={failed.has(card.id) ? { ...card, delivery: "missing", displayUrl: undefined } : card}
      onDeliveryFailure={id => setFailed(previous => new Set([...previous, id]))} />)}
    {!profile.cards.length && <p>No verified photo is available for this university yet.</p>}
    {profile.cards.length > 0 && failed.size === profile.cards.length && <p>No verified photo could be displayed.</p>}
    <p>Other campus categories and a campus description are not available in this first profile.</p>
  </section>;
}
