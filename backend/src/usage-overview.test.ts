import { expect, test } from "bun:test";
import { collectSessionUsage, emptyUsageOverview, localDate, mergeUsageOverview } from "./usage-overview";

test("usage counts actual rounds, tokens once per message and successful skills", () => {
	const start = new Date(2026, 9, 1, 10).getTime();
	const user = { info: { id: "u", role: "user", time: { created: start } }, parts: [] };
	const tool = { info: { id: "a1", role: "assistant", parentID: "u", modelID: "m", time: { created: start + 1000, completed: start + 2000 }, finish: "tool-calls", tokens: { input: 100, output: 10, cache: { read: 30 } } }, parts: [{ id: "tool", callID: "c", type: "tool", tool: "skill", state: { status: "completed", input: { name: "frontend-design" } } }, { type: "step-finish", tokens: { input: 100, output: 10 } }] };
	const final = { info: { id: "a2", role: "assistant", parentID: "u", modelID: "m", time: { created: start + 3000, completed: start + 6000 }, finish: "stop", tokens: { input: 200, output: 20, cache: { read: 40 } } }, parts: [] };
	const result = collectSessionUsage([final, tool, user, tool], "work");
	expect(result.inputTokens).toBe(300); expect(result.outputTokens).toBe(30); expect(result.cacheReadTokens).toBe(70);
	expect(result.turns).toBe(1); expect(result.workTurns).toBe(1); expect(result.chatTurns).toBe(0);
	expect(result.totalDurationMs).toBe(6000); expect(result.longestTurnMs).toBe(6000);
	expect(result.days).toEqual([{ date: localDate(start), inputTokens: 300, outputTokens: 30, cacheReadTokens: 70, turns: 1 }]);
	expect(result.toolCalls).toBe(1); expect(result.skills).toEqual([{ id: "frontend-design", calls: 1 }]);
	expect(result.models).toEqual([{ id: "m", replies: 2, tokens: 400 }]);
});

test("missing, failed and active rounds never invent completed usage or successful skill calls", () => {
	const result = collectSessionUsage([{ info: { id: "u", role: "user", time: { created: 1000 } } }, { info: { id: "a", role: "assistant", time: { created: 2000, completed: 3000 }, error: { name: "APIError" }, tokens: { input: -1, output: NaN, cache: { read: Infinity } } }, parts: [{ type: "tool", tool: "skill", state: { status: "error", input: { name: "bad" } } }] }], "chat");
	expect(result.turns).toBe(0); expect(result.inputTokens + result.outputTokens + result.cacheReadTokens).toBe(0); expect(result.skills).toEqual([]);
});

test("session aggregation merges dates and skills without losing work/chat totals", () => {
	const result = emptyUsageOverview(2);
	const first = { ...emptyUsageOverview(), turns: 1, workTurns: 1, inputTokens: 50, longestTurnMs: 100, days: [{ date: "2026-10-01", inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, turns: 1 }], skills: [{ id: "read-docs", calls: 2 }], models: [{ id: "m", tokens: 50, replies: 1 }] };
	mergeUsageOverview(result, first); mergeUsageOverview(result, { ...first, workTurns: 0, chatTurns: 1 });
	expect(result.sessions).toBe(2); expect(result.turns).toBe(2); expect(result.workTurns).toBe(1); expect(result.chatTurns).toBe(1);
	expect(result.days[0].inputTokens).toBe(100); expect(result.skills[0].calls).toBe(4); expect(result.models[0].tokens).toBe(100);
});
