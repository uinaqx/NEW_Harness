import { expect, test } from "bun:test";
import { EventNormalizer } from "./normalize";

test("authoritative final reply is shown once when it overtakes streamed deltas", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	const parts = [{ id: "r", type: "reasoning", text: "Hidden analysis" }, { id: "a", type: "text", text: "已完成。" }];
	expect(normalizer.reconcileFinal({ info: { id: "m", role: "assistant" }, parts })).toEqual([{ kind: "reasoning", text: "Hidden analysis" }, { kind: "text", text: "已完成。" }]);
	for (const part of parts) {
		expect(normalizer.handle({ type: "message.part.updated", properties: { part: { ...part, text: "" } } })).toEqual([]);
		expect(normalizer.handle({ type: "message.part.delta", properties: { partID: part.id, field: "text", delta: part.text } })).toEqual([]);
	}
	expect(normalizer.reconcileFinal({ parts })).toEqual([]);
	// Closing the previous reply must not discard the next turn.
	expect(normalizer.reconcileFinal({ parts: [{ id: "b", type: "text", text: "下一轮回复。" }] })).toEqual([{ kind: "text", text: "下一轮回复。" }]);
});

test("reasoning deltas with field=text never enter the answer stream", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	normalizer.handle({ type: "message.part.updated", properties: { part: { id: "r", type: "reasoning", text: "" } } });
	expect(normalizer.handle({ type: "message.part.delta", properties: { partID: "r", field: "text", delta: "Let me think." } })).toEqual([{ kind: "reasoning", text: "Let me think." }]);
	expect(normalizer.handle({ type: "message.part.updated", properties: { part: { id: "r", type: "reasoning", text: "Let me think." } } })).toEqual([]);
	normalizer.handle({ type: "message.part.updated", properties: { part: { id: "t", type: "text", text: "" } } });
	expect(normalizer.handle({ type: "message.part.delta", properties: { partID: "t", field: "text", delta: "已经完成。" } })).toEqual([{ kind: "text", text: "已经完成。" }]);
});

test("reordered untyped reasoning deltas remain hidden until typed", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	expect(normalizer.handle({ type: "message.part.delta", properties: { partID: "r", field: "text", delta: "Hidden analysis" } })).toEqual([]);
	expect(normalizer.handle({ type: "message.part.updated", properties: { part: { id: "r", type: "reasoning", text: "Hidden analysis" } } })).toEqual([{ kind: "reasoning", text: "Hidden analysis" }]);
});

test("user attachment text parts never become assistant text events", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	normalizer.handle({ type: "message.updated", properties: { info: { id: "u", role: "user" } } });
	expect(normalizer.handle({ type: "message.part.updated", properties: { part: { id: "p", messageID: "u", type: "text", text: "document body" } } })).toEqual([]);
});

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

test("question lifecycle surfaces choices once and clears after reply", () => {
	const normalizer = new EventNormalizer({ sessionId: "s" });
	const asked = { type: "question.asked", properties: { id: "q", sessionID: "s", questions: [{ header: "风格", question: "选择风格", options: [{ label: "简洁", description: "单色" }] }] } };
	expect(normalizer.handle(asked)).toEqual([{ kind: "question", item: { requestId: "q", sessionId: "s", questions: asked.properties.questions } }]);
	expect(normalizer.handle(asked)).toEqual([]);
	expect(normalizer.handle({ type: "question.replied", properties: { requestID: "q", sessionID: "s" } })).toEqual([{ kind: "question-cleared", requestId: "q" }]);
});
