/** Browser regression: live canvas steps survive navigation away and back. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useChatSession, type ChatSessionApi } from "../src/hooks/use-chat-session";
import { desktopClient } from "../src/lib/desktop-client";
import type { AgentChunkEvent, ChatMessage } from "../src/lib/chat-schema";
import { ChatMessages } from "../src/components/chat-messages";
import { TaskResult } from "../src/components/task-result";
import { ExecutionCanvas } from "../src/components/execution-canvas";

const handlers = new Map<string, Set<(payload: unknown) => void>>();
const fake = desktopClient as unknown as {
	subscribe: (name: string, callback: (payload: unknown) => void) => () => void;
	subscribeTransportState: (callback: (state: "connected") => void) => () => void;
	invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};
fake.subscribe = (name, callback) => { const set = handlers.get(name) ?? new Set(); set.add(callback); handlers.set(name, set); return () => set.delete(callback); };
fake.subscribeTransportState = (callback) => { callback("connected"); return () => {}; };
const user = (sessionId: string): ChatMessage => ({ id: `user-${sessionId}`, sessionId, role: "user", content: `任务 ${sessionId}`, createdAt: 1 });
const histories = new Map<string, ChatMessage[]>();
const completedDiffs = [{ file: "a.ts", additions: 2, deletions: 1, patch: "+new", status: "modified" }];
let workCompleted = false;
let deferredDiffs = false;
const diffResolvers: Array<(result: unknown) => void> = [];
fake.invoke = async (command, args = {}) => {
	const id = String(args.sessionId ?? "A");
	switch (command) {
		case "get_app_info": return {};
		case "get_model_settings": return { settings: null };
		case "engine_status": return { state: "running" };
		case "list_sessions": return { sessions: [] };
		case "list_projects": return { projects: [] };
		case "read_session_messages": return { messages: histories.get(id) ?? [user(id)] };
		case "get_session": return { session: { config: { workspaceRoot: "C:\\test", provider: "openai-compatible", model: "mock", mode: "act", apiKey: "", kind: id === "C" ? "chat" : "work" }, status: "idle" } };
		case "chat_session_command": {
			const previous = histories.get(id) ?? [user(id)];
			histories.set(id, [...previous, { ...user(id), id: `user-${Date.now()}`, content: String(args.prompt), createdAt: Date.now() }]);
			return {};
		}
		case "poll_tool_approvals": return { approvals: [] };
		case "poll_agent_questions": return { questions: [] };
		case "list_session_diffs": return deferredDiffs ? new Promise((resolve) => diffResolvers.push(resolve)) : { diffs: id === "A" && workCompleted ? completedDiffs : [] };
		default: return {};
	}
};
function emit(name: string, payload: unknown) { for (const callback of handlers.get(name) ?? []) callback(payload); }
let api: ChatSessionApi;
function Fixture() { const current = useChatSession(); useEffect(() => { api = current; }); return <div><ChatMessages messages={current.messages} status={current.status} streamingId={current.streamingId} error={null} deferActiveAnswer={current.config?.kind !== "chat"} afterMessages={<ExecutionCanvas messages={current.messages} status={current.status} sessionId={current.sessionId} approvals={[]} questions={[]} startedAt={current.runStartedAt} onApprove={() => {}} onReject={() => {}} onAnswer={async () => {}} />}><TaskResult startedAt={current.runStartedAt} endedAt={current.runEndedAt} busy={current.isBusy} status={current.runOutcome} summary={current.summary} hasUsage={current.hasUsage} diffs={current.diffs} onOpenFile={() => {}} onReview={() => {}} /></ChatMessages></div>; }
createRoot(document.getElementById("root")!).render(<Fixture />);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
const checks: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean) => checks.push({ name, ok });
let index = 0;
function chunk(stream: string, value: unknown): AgentChunkEvent { return { sessionId: "A", stream, chunk: typeof value === "string" ? value : JSON.stringify(value), ts: Date.now(), index: index++ }; }
void (async () => {
	await pause();
	await api.selectSession("A"); await pause();
	emit("chat_event", chunk("chat_queued_prompt_start", { prompt: "任务 A" }));
	emit("chat_session_status", { sessionId: "A", status: "running" });
	emit("chat_event", chunk("chat_step_intent", { text: "读取项目入口文件" }));
	emit("chat_event", chunk("chat_tool_call_start", { toolCallId: "call-1", toolName: "read", input: { filePath: "a.ts" } }));
	await pause();
	check("running canvas has first live step", api.messages.some((item) => item.meta?.toolCallId === "call-1" && item.meta.stepIntent === "读取项目入口文件"));
	await api.selectSession("B"); await pause();
	emit("chat_event", chunk("chat_tool_call_update", { toolCallId: "call-1", update: { chunk: "read output" } }));
	emit("chat_event", chunk("chat_tool_call_end", { toolCallId: "call-1", toolName: "read", input: { filePath: "a.ts" }, output: "read output" }));
	emit("chat_event", chunk("chat_step_intent", { text: "修改页面布局样式" }));
	emit("chat_event", chunk("chat_tool_call_start", { toolCallId: "call-2", toolName: "edit", input: { filePath: "a.ts" } }));
	await api.selectSession("A"); await pause();
	check("returning to running session preserves canvas and queued steps", api.status === "running" && api.messages.some((item) => item.meta?.toolCallId === "call-1" && item.meta.phase === "success") && api.messages.some((item) => item.meta?.toolCallId === "call-2" && item.meta.stepIntent === "修改页面布局样式"));
	emit("chat_event", chunk("chat_tool_call_end", { toolCallId: "call-2", toolName: "edit", output: "done" }));
	emit("chat_event", chunk("chat_text", "同步出现的最终结果")); await pause();
	check("Work buffers final output while the canvas is executing", !document.querySelector(".chat-scroll")!.textContent!.includes("同步出现的最终结果") && document.querySelector(".harness-execution")?.getAttribute("data-open") === "true");
	workCompleted = true;
	emit("chat_event", chunk("chat_done", { reason: "completed", diffs: completedDiffs })); await pause();
	check("completion reveals file collection alongside final output", document.querySelector(".task-file-list")?.textContent?.includes("a.ts") === true);
	check("completion event reveals the result and collapses the canvas in one render", document.querySelector(".chat-scroll")!.textContent!.includes("同步出现的最终结果") && document.querySelector(".harness-execution")?.getAttribute("data-open") === "false");
	emit("chat_session_status", { sessionId: "A", status: "completed" });
	await pause();
	check("completed run keeps final result state", api.runOutcome === "completed" && api.messages.filter((item) => item.role === "tool").length === 2);
	deferredDiffs = true;
	const firstRead = api.loadDiffs(), secondRead = api.loadDiffs(); await pause();
	diffResolvers[1]!({ diffs: completedDiffs }); await secondRead; await pause();
	diffResolvers[0]!({ diffs: [] }); await firstRead; await pause();
	check("late empty diff request cannot erase a newer file collection", api.diffs[0]?.file === "a.ts");
	deferredDiffs = false;
	await api.selectSession("C"); await pause();
	for (let turn = 1; turn <= 3; turn++) {
		await api.send(`续聊 ${turn}`); await pause();
		const event = (stream: string, value: unknown) => ({ ...chunk(stream, value), sessionId: "C" });
		emit("chat_event", event("chat_queued_prompt_start", {}));
		emit("chat_session_status", { sessionId: "C", status: "running" });
		emit("chat_event", event("chat_reasoning", { text: "Hidden English thinking" }));
		// Burst delivery exercises the ref/state ordering before React renders.
		emit("chat_event", event("chat_text", `答复 ${turn}`));
		emit("chat_event", event("chat_text", " 已完成"));
		await pause();
		check(`continuation ${turn} renders a complete answer without navigation`, api.messages.at(-1)?.content === `答复 ${turn} 已完成`);
		histories.set("C", [...histories.get("C")!, { id: `answer-${turn}`, sessionId: "C", role: "assistant", content: `答复 ${turn} 已完成`, createdAt: Date.now() }]);
		emit("chat_event", event("chat_done", { reason: "completed" }));
		emit("chat_session_status", { sessionId: "C", status: "completed" });
		await pause();
	}
	await api.send("延迟回复"); await pause();
	emit("chat_event", { ...chunk("chat_queued_prompt_start", {}), sessionId: "C" });
	emit("chat_event", { ...chunk("chat_done", { reason: "completed" }), sessionId: "C" });
	emit("chat_session_status", { sessionId: "C", status: "completed" });
	setTimeout(() => histories.set("C", [...histories.get("C")!, { id: "late-answer", sessionId: "C", role: "assistant", content: "延迟的最终回复", createdAt: Date.now() }]), 1800);
	await new Promise((resolve) => setTimeout(resolve, 2300));
	check("completed turn reconciles delayed final text without refresh", api.messages.at(-1)?.content === "延迟的最终回复");
	const output = document.createElement("script"); output.id = "ui-qa-result"; output.type = "application/json"; output.textContent = JSON.stringify(checks); document.body.append(output);
})();
