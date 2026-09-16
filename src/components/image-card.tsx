"use client";
import type { ImageCardData } from "@/server/contracts";
export function ImageCard({ card, onDeliveryFailure }: { card: ImageCardData; onDeliveryFailure: (id: string) => void }): React.JSX.Element {
  return card.delivery === "remote" && card.displayUrl ? (
    <figure>
      {/* Direct publisher delivery is deliberate: next/image would proxy/cache restricted media. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={card.displayUrl} alt={`${card.category} at the selected university`} referrerPolicy="no-referrer" onError={() => onDeliveryFailure(card.id)} />
      <figcaption><a href={card.source.url} target="_blank" rel="noopener noreferrer">Publisher source</a> · {card.score}/100 — {card.status}
        {card.source.policy.attributionText && <span> · {card.source.policy.attributionText}</span>}
        {card.source.policy.licenseUrl && <span> · <a href={card.source.policy.licenseUrl} target="_blank" rel="noopener noreferrer">License</a></span>}
      </figcaption>
    </figure>
  ) : <p><a href={card.source.url} target="_blank" rel="noopener noreferrer">Publisher source</a> — Image unavailable</p>;
}
