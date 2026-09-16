import type { ProfileEvent } from "./events";
import { profileEventSchema } from "./event-schema";
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: ProfileEvent) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", total = 0, lineBytes = 0, sequence = 0, requestId: string | undefined;
  let terminal = false, identity = false, clarification = false;
  const revisions = new Map<string, number>();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  function consume(event: ProfileEvent) {
    if (terminal || (requestId && requestId !== event.requestId)) throw new Error("protocol_error");
    requestId = event.requestId;
    if (event.seq <= sequence) return;
    if (event.seq !== sequence + 1) throw new Error("protocol_error");
    sequence = event.seq;
    if (clarification && event.type !== "final") throw new Error("protocol_error");
    if (event.type === "identity") { if (identity) throw new Error("protocol_error"); identity = true; }
    if (event.type === "clarification") { if (identity) throw new Error("protocol_error"); clarification = true; }
    if (event.type === "image") {
      if (!identity) throw new Error("protocol_error");
      if ((revisions.get(event.data.card.id) ?? 0) >= event.data.card.revision) return;
      revisions.set(event.data.card.id, event.data.card.revision);
    }
    if (event.type === "final") {
      const { state, profile } = event.data;
      if ((clarification && (state !== "needs_selection" || profile !== null))
        || (!clarification && state === "needs_selection") || (identity && (!profile || profile.state !== state))
        || (!identity && (profile || !["not_found", "unavailable", "needs_selection"].includes(state)))) throw new Error("protocol_error");
    }
    terminal = event.type === "final" || event.type === "fatal";
    onEvent(event);
  }
  try {
    while (true) {
      if (signal.aborted) throw new Error("cancelled");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("cancelled");
      if (done) break;
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) throw new Error("protocol_error");
      // Count bytes before decoding/concatenating, including incomplete UTF-8 tails.
      for (const byte of value) {
        if (byte === 10) lineBytes = 0;
        else if (++lineBytes > 256 * 1024) throw new Error("protocol_error");
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) consume(profileEventSchema.parse(JSON.parse(line)));
    }
    pending += decoder.decode();
    if (pending || !terminal) throw new Error("protocol_error");
  } catch (error) {
    if (signal.aborted) throw new Error("cancelled");
    if (error instanceof Error && error.message === "protocol_error") throw error;
    throw new Error("protocol_error");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
