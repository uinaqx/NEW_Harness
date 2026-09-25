import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./chat-schema";
import { currentTurnSteps, executionCapacity, executionDescription, pruneExecutionMessages } from "./execution-window";

const user = (id: string): ChatMessage => ({ id, sessionId: "s", role: "user", content: id, createdAt: 1 });
const tool = (id: string, phase: "success" | "running" = "success", input: unknown = { path: `${id}.ts` }): ChatMessage => ({
	id, sessionId: "s", role: "tool", content: JSON.stringify({ input }), createdAt: 2,
	meta: { toolCallId: id, toolName: "read", phase, hookEventName: phase === "running" ? "tool_call_start" : "tool_call_end" },
});

describe("live execution trace", () => {
	test("shows only the latest user turn, even when earlier turns contain tools", () => {
		const messages = [user("old"), tool("old-tool"), user("new"), tool("new-tool")];
		expect(currentTurnSteps(messages).map((message) => message.id)).toEqual(["new-tool"]);
		expect(pruneExecutionMessages(messages, 1)).toEqual(messages);
	});

	test("capacity responds to height and approval controls", () => {
		expect(executionCapacity(400)).toBeGreaterThan(executionCapacity(230));
		expect(executionCapacity(400, 2)).toBeLessThan(executionCapacity(400));
		expect(executionCapacity(0)).toBe(1);
	});

	test("evicts old finished steps but retains running and awaiting approval", () => {
		const messages = [user("prompt"), tool("one"), tool("running", "running"), tool("two"), tool("approval")];
		const kept = pruneExecutionMessages(messages, 1, ["approval"]);
		expect(currentTurnSteps(kept).map((message) => message.id)).toEqual(["running", "approval"]);
	});

	test("uses actual tool input for the one-line explanation", () => {
		expect(executionDescription(tool("x", "success", { command: "bun  test\n--watch" }))).toBe("bun test --watch");
		expect(executionDescription(tool("x", "success", {}))).toBe("查看执行详情");
	});
});
