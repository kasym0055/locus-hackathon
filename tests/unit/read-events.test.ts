import { expect, it } from "vitest";
import { readEvents } from "@/lib/read-events";
const id = "e3811aae-9ec9-4bbb-a32f-b62af38f4337";
const frame = (seq: number, type = "stage", data: unknown = { stage: "resolving" }, requestId = id) => JSON.stringify({ v: 1, requestId, seq, type, data }) + "\n";
const terminal = (seq: number) => frame(seq, "final", { state: "unavailable", profile: null, elapsedMs: 12 });
function bytes(chunks: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }); }
function byteStream(chunks: string[]) { return bytes(chunks.map((chunk) => new TextEncoder().encode(chunk))); }
const signal = () => new AbortController().signal;
it("decodes split UTF-8 and split JSON through a terminal record", async () => {
  const input = new TextEncoder().encode(frame(1, "warning", { code: "dependency_unavailable", message: "Үлгі" }) + terminal(2));
  const at = input.indexOf(0xd2); const seen: unknown[] = [];
  await readEvents(bytes([input.slice(0, at + 1), input.slice(at + 1, at + 5), input.slice(at + 5)]), e => seen.push(e), signal());
  expect(seen).toHaveLength(2); expect(seen[0]).toMatchObject({ data: { message: "Үлгі" } });
});
it.each([
  ["missing terminal", frame(1)], ["sequence gap", frame(1) + terminal(3)],
  ["conflicting ID", frame(1) + frame(2, "final", { state: "unavailable", profile: null, elapsedMs: 0 }, "abca1aae-9ec9-4bbb-a32f-b62af38f4337")],
  ["post-terminal", terminal(1) + frame(2)], ["unterminated final", terminal(1).trimEnd()],
  ["extra payload", frame(1, "stage", { stage: "resolving", bytes: [1] }) + terminal(2)],
  ["oversized line", "x".repeat(256 * 1024 + 1)], ["invalid JSON", "{\n"],
])("rejects %s", async (_label, input) => {
  await expect(readEvents(byteStream([input]), () => {}, signal())).rejects.toThrow("protocol_error");
});
it("ignores already seen sequence numbers", async () => {
  const seen: unknown[] = [];
  await readEvents(byteStream([frame(1) + frame(1) + terminal(2)]), e => seen.push(e), signal());
  expect(seen).toHaveLength(2);
});
it("aborts a pending read and cancels the reader", async () => {
  let cancelled = false; const abort = new AbortController();
  const pending = readEvents(new ReadableStream({ cancel() { cancelled = true; } }), () => {}, abort.signal);
  abort.abort(); await expect(pending).rejects.toThrow("cancelled"); expect(cancelled).toBe(true);
});
it("does not carry a stream without identity into an image or a profile final", async () => {
  const { universityFixture, decisionFixture } = await import("../support/fixtures");
  const source = decisionFixture({ authority: "official", association: "explicit", corroboration: 0, visual: 10 }).evidence.source;
  const card = { id: "a", revision: 1, category: "campus", tags: [], status: "verified", score: 80, components: { authority: 25, attribution: 45, corroboration: 0, visual: 10 }, reasons: [], source, delivery: "remote", displayUrl: "https://example.edu/photo.jpg" };
  await expect(readEvents(byteStream([frame(1, "image", { card }) + terminal(2)]), () => {}, signal())).rejects.toThrow("protocol_error");
  const university = universityFixture();
  await expect(readEvents(byteStream([frame(1, "identity", { university }) + terminal(2)]), () => {}, signal())).rejects.toThrow("protocol_error");
  await expect(readEvents(byteStream([frame(1, "identity", { university }) + frame(2, "image", { card: { ...card, displayUrl: "javascript:alert(1)" } })]), () => {}, signal())).rejects.toThrow("protocol_error");
});
it("bounds total bytes even when each individual line is small", async () => {
  const chunk = frame(1, "warning", { code: "dependency_unavailable", message: "x".repeat(1800) });
  await expect(readEvents(byteStream(Array(1200).fill(chunk)), () => {}, signal())).rejects.toThrow("protocol_error");
});
it("rejects invalid UTF-8", async () => {
  await expect(readEvents(bytes([new Uint8Array([255, 10])]), () => {}, signal())).rejects.toThrow("protocol_error");
});
