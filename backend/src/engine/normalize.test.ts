import { expect, test } from "bun:test";
import { EventNormalizer } from "./normalize";

test("usage updates replace initial zero and do not count redelivered cumulative totals twice", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	const message = (input: number, output: number) => ({ type: "message.updated", properties: { info: { id: "m", role: "assistant", tokens: { input, output, cache: { read: 10 } } } } });
	const events = [...normalizer.handle(message(0, 0)), ...normalizer.handle(message(100, 20)), ...normalizer.handle(message(100, 20)), ...normalizer.handle(message(100, 25))].filter((event) => event.kind === "usage");
	expect(events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0)).toBe(100);
	expect(events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0)).toBe(25);
	expect(events.reduce((sum, event) => sum + (event.cacheReadTokens ?? 0), 0)).toBe(10);
});

test("tool-end carries actual diff metadata to the UI", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	const metadata = { filediff: { additions: 49, deletions: 0 }, exit: 0 };
	const events = normalizer.handle({ type: "message.part.updated", properties: { part: { id: "p", type: "tool", tool: "edit", callID: "c", state: { status: "completed", input: { filePath: "file.ts" }, output: "edited", metadata, time: { start: 1, end: 3 } } } } });
	const end = events.find((event) => event.kind === "tool-end");
	expect(end?.metadata).toEqual(metadata);
	expect(end?.durationMs).toBe(2);
});
