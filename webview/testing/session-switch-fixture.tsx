/** Browser regression: live canvas steps survive navigation away and back. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useChatSession, type ChatSessionApi } from "../src/hooks/use-chat-session";
import { desktopClient } from "../src/lib/desktop-client";
import type { AgentChunkEvent, ChatMessage } from "../src/lib/chat-schema";

const handlers = new Map<string, Set<(payload: unknown) => void>>();
const fake = desktopClient as unknown as {
	subscribe: (name: string, callback: (payload: unknown) => void) => () => void;
	subscribeTransportState: (callback: (state: "connected") => void) => () => void;
	invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};
fake.subscribe = (name, callback) => { const set = handlers.get(name) ?? new Set(); set.add(callback); handlers.set(name, set); return () => set.delete(callback); };
fake.subscribeTransportState = (callback) => { callback("connected"); return () => {}; };
const user = (sessionId: string): ChatMessage => ({ id: `user-${sessionId}`, sessionId, role: "user", content: `任务 ${sessionId}`, createdAt: 1 });
fake.invoke = async (command, args = {}) => {
	const id = String(args.sessionId ?? "A");
	switch (command) {
		case "get_app_info": return {};
		case "get_model_settings": return { settings: null };
		case "engine_status": return { state: "running" };
		case "list_sessions": return { sessions: [] };
		case "list_projects": return { projects: [] };
		case "read_session_messages": return { messages: [user(id)] };
		case "get_session": return { session: { config: { workspaceRoot: "C:\\test", provider: "openai-compatible", model: "mock", mode: "act", apiKey: "", kind: "work" }, status: "idle" } };
		case "poll_tool_approvals": return { approvals: [] };
		case "poll_agent_questions": return { questions: [] };
		case "list_session_diffs": return { diffs: [] };
		default: return {};
	}
};
function emit(name: string, payload: unknown) { for (const callback of handlers.get(name) ?? []) callback(payload); }
let api: ChatSessionApi;
function Fixture() { const current = useChatSession(); useEffect(() => { api = current; }); return <div>{current.sessionId}: {current.status} · {current.messages.filter((item) => item.role === "tool").length}</div>; }
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
	emit("chat_event", chunk("chat_done", { reason: "completed", text: "" }));
	emit("chat_session_status", { sessionId: "A", status: "completed" });
	await pause();
	check("completed run keeps final result state", api.runOutcome === "completed" && api.messages.filter((item) => item.role === "tool").length === 2);
	const output = document.createElement("script"); output.id = "ui-qa-result"; output.type = "application/json"; output.textContent = JSON.stringify(checks); document.body.append(output);
})();
