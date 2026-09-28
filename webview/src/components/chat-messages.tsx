import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Loader2, AlertTriangle, UserRound } from "lucide-react";
import { BrandMark } from "./brand-mark";
import type { ChatMessage, ChatSessionStatus } from "@/lib/chat-schema";
import { cn } from "@/lib/utils";

interface Props {
	messages: ChatMessage[];
	status: ChatSessionStatus;
	streamingId: string | null;
	error: string | null;
	showWaiting?: boolean;
	children?: ReactNode;
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

export function ChatMessages({ messages, status, streamingId, error, showWaiting = false, children }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const isBusy = status === "starting" || status === "running" || status === "stopping";
	const awaitingFirst = isBusy && !streamingId && !messages.some((m) => m.role === "tool" && m.meta?.hookEventName === "tool_call_start");

	useEffect(() => {
		const el = scrollRef.current;
		if (el && followLatest.current) el.scrollTop = el.scrollHeight;
	}, [messages, streamingId, children]);

	const items = useMemo(() => messages.filter((message) => message.role === "user" || message.role === "error" || (message.role === "assistant" && message.content.trim())), [messages]);

	if (messages.length === 0 && !isBusy) {
		return null;
	}

	return (
		<div className="chat-scroll" ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
			<div className="chat-inner">
				{items.map((m) => {
					const isUser = m.role === "user";
					const isAssistant = m.role === "assistant";
					const isError = m.role === "error";
					const isStreaming = streamingId === m.id;
					if (m.role === "system") return null;
					return (
						<div className="msg" key={m.id}>
							<div className="msg-row">
								<div className={cn("msg-avatar", isUser ? "user" : isError ? "tool" : "assistant")}>
									{isUser ? <UserRound size={14} /> : isError ? <AlertTriangle size={14} /> : <BrandMark size={26} />}
								</div>
								<div className="msg-body">
									<div className="msg-role">{isUser ? "用户" : isError ? "错误" : "某科学的Agent"}</div>
									<div className={cn("msg-content", isUser ? "msg-user" : isAssistant ? "msg-assistant" : isError ? "msg-error" : "")}>
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
				{showWaiting && awaitingFirst && (
					<div className="msg-status"><Loader2 size={14} className="spin" /> 正在等待回复…</div>
				)}
				{children}
			</div>
		</div>
	);
}
