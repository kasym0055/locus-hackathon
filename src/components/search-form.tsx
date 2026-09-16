"use client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ImageCardData, Profile, University } from "@/server/contracts";
import { readEvents } from "@/lib/read-events";
import { ProfileView } from "./profile-view";
const stages = { resolving: "Checking university identity…", discovering: "Reading publisher sources…", preparing: "Checking image delivery…", assessing: "Assessing the photo and evidence…", assembling: "Assembling the profile…" };
export function SearchForm(): React.JSX.Element {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState("Enter a university name to begin.");
  const [busy, setBusy] = useState(false); const [profile, setProfile] = useState<Profile | null>(null);
  const [attempt, setAttempt] = useState(0); const [canRetry, setCanRetry] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setProfile(null); setAttempt(value => value + 1); setBusy(true); setCanRetry(false); setStatus("Starting request…");
    let university: University | undefined; const cards = new Map<string, ImageCardData>();
    const update = () => {
      if (university) setProfile({ university, cards: [...cards.values()], description: [], sources: [], gaps: {}, state: "partial", verifiedBaseCategories: 0, warnings: [], provenance: "live", elapsedMs: 0 });
    };
    try {
      const session = await fetch("/api/session", { method: "POST", credentials: "same-origin", signal: controller.signal, cache: "no-store" });
      if (!session.ok) throw new Error("unavailable");
      const response = await fetch("/api/profile", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, countryHint: "" }), signal: controller.signal, cache: "no-store" });
      if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("unavailable");
      await readEvents(response.body, event => {
        if (active.current !== controller || controller.signal.aborted) return;
        if (event.type === "stage") setStatus(stages[event.data.stage]);
        if (event.type === "identity") { university = event.data.university; update(); }
        if (event.type === "image") { cards.set(event.data.card.id, event.data.card); update(); }
        if (event.type === "clarification") setStatus("Several campuses match. Add the city or country to your search.");
        if (event.type === "fatal") { setStatus(event.data.code === "busy" ? "The service is busy. Please retry shortly." : "The service is unavailable. Please retry later."); setCanRetry(true); }
        if (event.type === "final") {
          setProfile(event.data.profile);
          const messages = { complete: "Profile ready.", partial: "Partial profile — one or more campus categories are missing.", insufficient_evidence: "Insufficient evidence — no verified photo is available.", unavailable: "The service is unavailable. Please retry later.", not_found: "No university match was found. Try its full name and location.", needs_selection: "Several campuses match. Add the city or country to your search." };
          setStatus(messages[event.data.state]); setCanRetry(event.data.state === "unavailable");
        }
      }, controller.signal);
    } catch (error) {
      if (active.current === controller) {
        const message = controller.signal.aborted ? "Cancelled. Any images already shown are a partial result."
          : error instanceof Error && error.message === "protocol_error" ? "Connection interrupted. Any images already shown are a partial result." : "The service is unavailable. Please retry later.";
        setStatus(message); setCanRetry(true); controller.abort();
      }
    } finally { if (active.current === controller) setBusy(false); }
  }
  return <>
    <form onSubmit={search} role="search">
      <label htmlFor="university-query">Search universities</label>
      <input id="university-query" name="query" value={query} onChange={event => setQuery(event.target.value)} placeholder="University name, city or country" type="search" minLength={2} maxLength={160} required />
      <div className="actions"><button type="submit">Search</button>{busy && <button type="button" className="secondary" onClick={() => active.current?.abort()}>Cancel</button>}
        {canRetry && !busy && <button type="button" className="secondary" onClick={() => void search()}>Retry</button>}</div>
    </form>
    <p role="status" aria-live="polite">{status}</p>
    {profile && <ProfileView key={attempt} profile={profile} />}
  </>;
}
