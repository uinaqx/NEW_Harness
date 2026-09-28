import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./chat-schema";
import { currentTurnSteps, executionCapacity, executionDescription, executionMetrics, formatDuration, pruneExecutionMessages, splitExecutionSteps } from "./execution-window";

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
		expect(executionDescription(tool("x", "success", { command: "bun  test\n--watch" }))).toBe("阅读文件内容 · bun test --watch");
		expect(executionDescription(tool("x", "success", {}))).toBe("阅读文件内容");
		const intended = tool("intent");
		expect(executionDescription({ ...intended, meta: { ...intended.meta, stepIntent: "阅读项目入口文件" } })).toBe("阅读项目入口文件");
	});

	test("retains every overflow step in chronological archive while keeping six recent rows", () => {
		const messages = [user("prompt"), ...Array.from({ length: 10 }, (_, index) => tool(String(index)))];
		const split = splitExecutionSteps(messages, 6);
		expect(split.archived.map((step) => step.id)).toEqual(["0", "1", "2", "3"]);
		expect(split.current).toHaveLength(6);
		expect(split.archived.length + split.current.length).toBe(10);
	});

	test("archive never takes running or authorization steps", () => {
		const messages = [user("prompt"), tool("running", "running"), tool("approval"), tool("done")];
		const split = splitExecutionSteps(messages, 1, ["approval"]);
		expect(split.current.map((step) => step.id)).toEqual(["running", "approval"]);
		expect(split.archived.map((step) => step.id)).toEqual(["done"]);
	});

	test("read counts actual numbered output and never guesses from a requested limit", () => {
		const read = tool("read", "success", { limit: 2000 });
		expect(executionMetrics({ ...read, meta: { ...read.meta, toolOutput: "<content>\n1: one\n2: two\n</content>" } }).readLines).toBe(2);
		expect(executionMetrics(read).readLines).toBeUndefined();
	});

	test("edit counts use engine diff metadata, and failed edits show no applied changes", () => {
		const edit = { ...tool("edit"), meta: { ...tool("edit").meta, toolName: "edit", toolMetadata: { filediff: { additions: 49, deletions: 0 } } } };
		expect(executionMetrics(edit)).toEqual({ additions: 49, deletions: 0 });
		expect(executionMetrics({ ...edit, content: '{"error":"denied"}' })).toEqual({});
	});

	test("unified diff counts exclude the header", () => {
		const edit = { ...tool("edit"), meta: { ...tool("edit").meta, toolName: "edit", toolMetadata: { diff: "--- a\n+++ b\n-old\n+new\n+second" } } };
		expect(executionMetrics(edit)).toEqual({ additions: 2, deletions: 1 });
		expect(formatDuration(123000)).toBe("2分3秒");
	});
});
