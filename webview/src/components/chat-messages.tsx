import { useEffect, useMemo, useRef } from "react";
import { Loader2, Terminal, FileText, Search, Pencil, ChevronDown, AlertTriangle } from "lucide-react";
import type { ChatMessage, ChatSessionStatus } from "@/lib/chat-schema";
import { executionPayload, executionFailed } from "@/lib/execution-window";
import { cn } from "@/lib/utils";

interface Props {
	messages: ChatMessage[];
	status: ChatSessionStatus;
	streamingId: string | null;
	error: string | null;
}

/** Minimal markdown-ish renderer: split on fenced ``` blocks. */
function renderContent(content: string) {
	if (!content) return null;
	const parts = content.split(/```/);
	return parts.map((part, i) => {
		if (i % 2 === 1) {
			// code block; first line may be a language tag
			const nl = part.indexOf("\n");
			const lang = nl > 0 ? part.slice(0, nl).trim() : "";
			const code = nl > 0 ? part.slice(nl + 1) : part;
			return (
				<pre key={i}>
					<code>{lang ? "" : ""}{code.replace(/\n$/, "")}</code>
				</pre>
			);
		}
		// text: render paragraphs
		return part.split(/\n{2,}/).map((para, j) =>
			para.trim() ? <p key={`${i}-${j}`}>{para}</p> : null,
		);
	});
}

function toolIcon(name: string) {
	if (/read|file/.test(name)) return FileText;
	if (/search|grep|list/.test(name)) return Search;
	if (/write|edit|patch/.test(name)) return Pencil;
	return Terminal;
}

export function ChatMessages({ messages, status, streamingId, error }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const isBusy = status === "starting" || status === "running" || status === "stopping";
	const awaitingFirst = isBusy && !streamingId && !messages.some((m) => m.role === "tool" && m.meta?.hookEventName === "tool_call_start");

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length, streamingId]);

	const items = useMemo(() => messages, [messages]);

	if (messages.length === 0 && !isBusy) {
		return null;
	}

	return (
		<div className="chat-scroll" ref={scrollRef}>
			<div className="chat-inner">
				{items.map((m) => {
					if (m.role === "tool") {
						const payload = executionPayload(m);
						const failed = executionFailed(payload) || m.meta?.hookEventName === "tool_call_interrupted";
						const running = m.meta?.hookEventName === "tool_call_start" && isBusy;
						const name = m.meta?.toolName ?? "工具";
						const Icon = toolIcon(name);
						return (
							<div className="msg-tool" key={m.id} data-failed={failed || undefined}>
								<div className="mt-head">
									<Icon size={14} />
									<span className="mt-name">{name}</span>
									<span className="mt-meta">
										{running ? "执行中…" : failed ? "失败" : "完成"}
										{m.meta?.durationMs != null ? ` · ${(m.meta.durationMs / 1000).toFixed(1)}s` : ""}
									</span>
								</div>
								{m.meta?.toolOutput && (
									<details>
										<summary>输出</summary>
										<pre>{m.meta.toolOutput.slice(0, 4000)}</pre>
									</details>
								)}
							</div>
						);
					}
					const isUser = m.role === "user";
					const isAssistant = m.role === "assistant";
					const isError = m.role === "error";
					const isStreaming = streamingId === m.id;
					if (m.role === "status") {
						// A compact one-line execution summary: the full tool output lives in
						// the canvas and the diff panel, not in the conversation.
						return (
							<div className="msg-status-line" key={m.id} data-bad={m.meta?.reason === "tool_failure" || undefined}>
								<Terminal size={12} />
								<span>{m.content}</span>
							</div>
						);
					}
					if (m.role === "system") return null;
					return (
						<div className="msg" key={m.id}>
							<div className="msg-row">
								<div className={cn("msg-avatar", isUser ? "user" : isError ? "tool" : "assistant")}>
									{isUser ? "你" : isError ? "!" : "H"}
								</div>
								<div className="msg-body">
									<div className="msg-role">{isUser ? "用户" : isError ? "错误" : "某科学的Agent"}</div>
									<div className={cn("msg-content", isUser ? "msg-user" : isAssistant ? "msg-assistant" : isError ? "msg-error" : "")}>
										{m.reasoning && (
											<details>
												<summary>思考过程</summary>
												<pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.8 }}>{m.reasoning}</pre>
											</details>
										)}
										{isStreaming && !m.content ? (
											<span className="msg-status"><Loader2 size={14} className="spin" /> 正在思考…</span>
										) : isError ? (
											<span style={{ display: "flex", gap: 8, alignItems: "center" }}><AlertTriangle size={14} /> {m.content}</span>
										) : (
											renderContent(m.content)
										)}
									</div>
								</div>
							</div>
						</div>
					);
				})}
				{awaitingFirst && (
					<div className="msg-status"><Loader2 size={14} className="spin" /> 正在连接模型，等待响应…</div>
				)}
			</div>
		</div>
	);
}
